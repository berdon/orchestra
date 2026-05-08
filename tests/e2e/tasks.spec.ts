import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { appendMockSessionEvent, buildMockSessionEvents, expectTranscriptAutoScrollOn } from "./session-scroll-helpers";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=";

async function setTaskOverviewFiltersExpanded(page: Page, expanded: boolean) {
  const toggle = page.locator('[data-role="task-overview-filters-toggle"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== String(expanded)) {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
}

async function getElementHeight(locator: Locator) {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => Math.round(element.getBoundingClientRect().height));
}

async function seedMobileTaskOverviewControlsData(page: Page) {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("orchestra.mock.mobile-overview-controls-seeded") === "true") {
      return;
    }
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.mobile-overview-controls-seeded", "true");
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-mobile-overview-controls",
          slug: "mobile-overview-controls",
          name: "Mobile Overview Controls Flow",
          description: "Flow used to verify the mobile task overview controls row.",
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
    const buildTask = (overrides: Record<string, unknown>) => ({
      projectId: "orchestra",
      description: null,
      type: "task",
      status: "ready",
      priority: "P2",
      workflowId: "workflow-mobile-overview-controls",
      currentLaneId: "lane-implement",
      assigneeType: "role",
      assigneeId: "developer",
      repositoryId: null,
      repositoryIds: [],
      parentTaskId: null,
      archived: false,
      tags: [],
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
  laneSummaries: [],
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    });
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        buildTask({
          id: "task-mobile-ready",
          number: "ORC-M1",
          title: "Ready mobile task",
          status: "ready",
          readyForDispatch: true,
        }),
        buildTask({
          id: "task-mobile-completed",
          number: "ORC-M2",
          title: "Completed mobile task",
          status: "completed",
          currentLaneId: null,
          laneRunCount: 1,
        }),
        buildTask({
          id: "task-mobile-blocked",
          number: "ORC-M3",
          title: "Blocked mobile task",
          status: "blocked",
        }),
        buildTask({
          id: "task-mobile-review",
          number: "ORC-M4",
          title: "Review mobile task",
          status: "in_review",
        }),
        buildTask({
          id: "task-mobile-epic",
          number: "ORC-M5",
          title: "Epic mobile task",
          type: "epic",
          readyForDispatch: true,
        }),
      ]),
    );
    window.localStorage.setItem("orchestra.mock.task-schedules", JSON.stringify([]));
  });
}

async function openTasksOverviewOnMobile(page: Page) {
  await page.goto("/");
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await page.getByRole("button", { name: "Tasks" }).click();
}

async function scrollTaskDetailTo(page: Page, top: number) {
  await page.evaluate((nextTop) => {
    const content = document.querySelector(".content") as HTMLElement | null;
    if (content && content.scrollHeight > content.clientHeight) {
      content.scrollTop = nextTop;
      content.dispatchEvent(new Event("scroll"));
      return;
    }
    window.scrollTo({ top: nextTop, behavior: "auto" });
    window.dispatchEvent(new Event("scroll"));
  }, top);
}

async function revealTaskDetailDock(page: Page) {
  const tabDock = page.locator('[data-role="task-detail-tab-dock"]');
  if (!(await tabDock.isVisible())) {
    await page.evaluate(() => {
      const content = document.querySelector(".content") as HTMLElement | null;
      if (content && content.scrollHeight > content.clientHeight) {
        content.scrollTop = 0;
        content.dispatchEvent(new Event("scroll"));
        return;
      }

      window.scrollTo({ top: 0, behavior: "auto" });
      window.dispatchEvent(new Event("scroll"));
    });
  }

  await expect.poll(async () => tabDock.getAttribute("data-scroll-state"), { timeout: 10_000 }).toBe("visible");
  await page.waitForTimeout(220);
  await expect(tabDock).toBeVisible();
}

async function seedMobileTaskDetailOverflowFixture(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const taskId = "task-mobile-overflow";
    const longPathSegment = "mobileoverflowsegment".repeat(14);
    const longCommentToken = "MOBILECOMMENTTOKEN".repeat(32);
    const relativePath = `docs/${longPathSegment}/notes.md`;
    const absolutePath = `/mock/projects/orchestra/repository/${relativePath}`;
    const comments = [
      {
        id: "comment-mobile-overflow-parent",
        taskId,
        parentCommentId: null,
        author: "Reviewer",
        message: `A long unbroken mobile task-detail token should wrap instead of widening the outer content scroller: ${longCommentToken}`,
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
    ];

    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([
      {
        id: taskId,
        projectId: "orchestra",
        number: "ORC-222",
        title: "Mobile task detail overflow regression fixture",
        description: "Seeds long task-detail content so mobile layout regressions cannot reintroduce right-side horizontal overflow.",
        type: "bug",
        status: "in_progress",
        priority: "P1",
        workflowId: null,
        currentLaneId: null,
        assigneeType: "unassigned",
        assigneeId: null,
        repositoryId: "repo-mobile-overflow",
        repositoryIds: ["repo-mobile-overflow"],
        parentTaskId: null,
        archived: false,
        tags: ["mobile", "regression"],
        commentCount: comments.length,
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
            repositoryId: "repo-mobile-overflow",
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
            id: "task-file-reference-mobile-overflow-default",
            taskId,
            repositoryId: "repo-mobile-overflow",
            repositoryName: "Orchestra repository",
            repositorySlug: "orchestra",
            relativePath,
            absolutePath,
            exists: true,
            isDefault: true,
            createdAt: timestamp,
          },
        ],
        comments,
        todos: [],
        laneRuns: [],
        activeLaneAssignment: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]));

    window.localStorage.setItem(
      "orchestra.mock.file-contents",
      JSON.stringify({
        [absolutePath]: [
          "Alpha line",
          "Beta line with ordinary preview content.",
          "Gamma line keeps the default file viewer mounted without relying on horizontal overflow.",
        ].join("\n"),
      }),
    );
  });
}

async function readMobileTaskDetailOverflowMetrics(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector(".content") as HTMLElement | null;
    if (!content) {
      throw new Error("Expected the main `.content` scroller to exist.");
    }
    return {
      clientWidth: content.clientWidth,
      scrollWidth: content.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

async function openTaskDetailSection(page: Page, section: "comments" | "timeline") {
  const changedViaSectionSelect = await page.evaluate((nextSection) => {
    const select = document.querySelector('[data-role="task-detail-section-select-control"]') as HTMLSelectElement | null;
    if (!select) {
      return false;
    }

    select.value = nextSection;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, section);
  if (changedViaSectionSelect) {
    return;
  }

  await revealTaskDetailDock(page);
  const tabRole = section === "comments" ? "task-detail-tab-comments" : "task-detail-tab-timeline";
  await page.locator(`[data-role="${tabRole}"]`).click();
}

async function seedClickableTagNavigationData(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-tag-navigation",
          slug: "tag-navigation",
          name: "Tag Navigation Flow",
          description: "Flow used to verify clickable task-tag navigation.",
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
          id: "task-tag-source",
          projectId: "orchestra",
          number: "ORC-30",
          title: "Backend source task",
          description: "Open me from detail or overview and click the backend tag.",
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-tag-navigation",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend", "ux"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
        {
          id: "task-tag-backend-match",
          projectId: "orchestra",
          number: "ORC-31",
          title: "Second backend task",
          description: "Should remain visible when backend is selected.",
          type: "task",
          status: "in_progress",
          priority: "P2",
          workflowId: "workflow-tag-navigation",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend"],
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
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-22T11:00:00.000Z",
        },
        {
          id: "task-tag-frontend-other",
          projectId: "orchestra",
          number: "ORC-32",
          title: "Frontend only task",
          description: "Should disappear when backend is selected.",
          type: "task",
          status: "ready",
          priority: "P3",
          workflowId: "workflow-tag-navigation",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["frontend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-22T12:00:00.000Z",
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.task-schedules", JSON.stringify([]));
  });
}

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

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Draft board task");
  await expect(page.locator('[data-role="publish-task"]')).toBeVisible();
  await expect(page.locator('[data-role="task-title-tags"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-tags"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("No description provided.");
  await expect(page.getByRole("button", { name: "Back to tasks" })).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");

  await page.locator('[data-role="task-card"]').filter({ hasText: "Draft board task" }).first().click();
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Draft board task");
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("No description provided.");
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");
});

test("tasks overview hides empty draft and scheduled sections and starts filters collapsed by default", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-quiet-overview",
          slug: "quiet-overview",
          name: "Quiet Overview Flow",
          description: "Simple lane for overview chrome coverage.",
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
          id: "task-backend-ready",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Backend only task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-quiet-overview",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-frontend-ready",
          projectId: "orchestra",
          number: "ORC-2",
          title: "Frontend only task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-quiet-overview",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["frontend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.task-schedules", JSON.stringify([]));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="draft-task-section"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-schedule-section"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-role="task-overview-filters-body"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("No active filters");
  await expect(page.getByText("Filters & sorting")).toHaveCount(0);
  await expect(page.getByText("Task filters")).toHaveCount(0);
  expect(await getElementHeight(page.locator('[data-role="task-overview-filters-card"]'))).toBeLessThan(76);

  await setTaskOverviewFiltersExpanded(page, true);
  await expect(page.locator('[data-role="task-sort-field"]')).toBeVisible();
  await expect(page.locator('[data-role="task-tag-filters"]')).toContainText("#backend");

  await page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]').click();
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Backend only task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Frontend only task");

  await setTaskOverviewFiltersExpanded(page, false);
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");
  await expect(page.locator('[data-role="task-overview-filters-active-count"]')).toHaveText("1 active");
});

test("tasks overview keeps collapsed filters compact while showing active filters and sort at narrower widths", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-compact-filters",
          slug: "compact-filters",
          name: "Compact Filters Flow",
          description: "Simple lane for compact filter coverage.",
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
          id: "task-backend-ready",
          projectId: "orchestra",
          number: "ORC-11",
          title: "Backend ready task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-compact-filters",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-frontend-ready",
          projectId: "orchestra",
          number: "ORC-12",
          title: "Frontend ready task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-compact-filters",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["frontend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await page.getByRole("button", { name: "Tasks" }).click();

  await setTaskOverviewFiltersExpanded(page, true);
  await page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]').click();
  await page.locator('[data-role="task-sort-field"]').selectOption("title");
  await page.locator('[data-role="task-sort-direction"]').selectOption("asc");
  await setTaskOverviewFiltersExpanded(page, false);

  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Sort: Title · Ascending");
  await expect(page.locator('[data-role="task-overview-filters-active-count"]')).toHaveText("2 active");
  expect(await getElementHeight(page.locator('[data-role="task-overview-filters-card"]'))).toBeLessThan(100);
});

test("tasks overview mobile row combines board filter select with the view toggle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskOverviewControlsData(page);
  await openTasksOverviewOnMobile(page);

  const mobileControls = page.locator('[data-role="task-overview-mobile-controls"]');
  const mobileFilterSelect = page.locator('[data-role="task-filter-select-mobile"]');
  await expect(mobileControls).toBeVisible();
  await expect(mobileControls).not.toContainText("Filter");
  await expect(mobileControls.getByRole("button")).toHaveCount(0);
  await expect(mobileFilterSelect).toBeVisible();
  await expect(mobileFilterSelect).toHaveAttribute("aria-label", "Task board filter");
  await expect(mobileFilterSelect).toHaveValue("all");
  await expect(page.locator('[data-role="task-nav-filters"]')).toBeHidden();
  await expect(page.locator('[data-role="task-view-toggle"]')).toBeVisible();
  await expect(page.locator('[data-role="task-view-cards"]')).toBeVisible();
  await expect(page.locator('[data-role="task-view-table"]')).toBeVisible();

  const controlsLayout = await page.locator(".task-overview-controls").evaluate((element) => {
    const mobileFilter = element.querySelector('[data-role="task-overview-mobile-controls"]');
    const viewToggle = element.querySelector('[data-role="task-view-toggle"]');
    if (!(mobileFilter instanceof HTMLElement) || !(viewToggle instanceof HTMLElement)) {
      throw new Error("Expected mobile filter and view toggle inside task overview controls");
    }
    const mobileFilterRect = mobileFilter.getBoundingClientRect();
    const viewToggleRect = viewToggle.getBoundingClientRect();
    return {
      verticalCenterDelta: Math.abs(
        (mobileFilterRect.top + mobileFilterRect.height / 2) - (viewToggleRect.top + viewToggleRect.height / 2),
      ),
      viewToggleStartsToTheRight: viewToggleRect.left > mobileFilterRect.left,
    };
  });
  expect(controlsLayout.verticalCenterDelta).toBeLessThan(24);
  expect(controlsLayout.viewToggleStartsToTheRight).toBe(true);
});

test("tasks overview mobile board filter select preserves filtering and table view switching", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskOverviewControlsData(page);
  await openTasksOverviewOnMobile(page);

  const mobileFilterSelect = page.locator('[data-role="task-filter-select-mobile"]');
  await mobileFilterSelect.selectOption("done");
  await expect(mobileFilterSelect).toHaveValue("done");
  await expect(page.locator('[data-role="workflow-done-grid"]')).toContainText("Completed mobile task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Ready mobile task");

  await page.locator('[data-role="task-view-table"]').click();
  await expect(page.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-role="task-table"]')).toContainText("Completed mobile task");
  await expect(page.locator('[data-role="task-table"]')).not.toContainText("Ready mobile task");

  await page.reload();
  await expect(mobileFilterSelect).toBeVisible();
  await expect(mobileFilterSelect).toHaveValue("done");
  await expect(page.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-role="task-table"]')).toContainText("Completed mobile task");
});

test("clicking a task detail tag chip returns to tasks overview filtered by that tag", async ({ page }) => {
  await seedClickableTagNavigationData(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"][data-task-id="task-tag-source"]').click();
  await expect(page.locator('[data-role="task-detail-panel"]')).toHaveAttribute("data-task-id", "task-tag-source");

  await page.locator('[data-role="task-title-tags"] [data-role="task-tag-chip"][data-tag-value="backend"]').click();

  await expect(page.locator('[data-role="task-detail-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toHaveClass(/filter-chip--active/);
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Backend source task");
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Second backend task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Frontend only task");
  await expect.poll(async () => page.evaluate(() => window.location.search.includes("selectedTaskId="))).toBe(false);
  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("orchestra.preferences.task-overview.v1.orchestra") ?? "")).toContain('"tags":["backend"]');
});

test("clicking a task card tag chip filters the tasks overview instead of opening task detail", async ({ page }) => {
  await seedClickableTagNavigationData(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"][data-task-id="task-tag-source"] [data-role="task-tag-chip"][data-tag-value="backend"]').click();

  await expect(page.locator('[data-role="task-detail-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toHaveClass(/filter-chip--active/);
  await expect(page.locator('[data-role="task-card"][data-task-id="task-tag-source"]')).toBeVisible();
  await expect(page.locator('[data-role="task-card"][data-task-id="task-tag-backend-match"]')).toBeVisible();
  await expect(page.locator('[data-role="task-card"][data-task-id="task-tag-frontend-other"]')).toHaveCount(0);
});

test("clicking a task table tag chip filters the tasks overview instead of opening task detail", async ({ page }) => {
  await seedClickableTagNavigationData(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-view-table"]').click();
  await page.locator('[data-role="task-table-row"][data-task-id="task-tag-source"] [data-role="task-tag-chip"][data-tag-value="backend"]').click();

  await expect(page.locator('[data-role="task-detail-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-table"]')).toBeVisible();
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toHaveClass(/filter-chip--active/);
  await expect(page.locator('[data-role="task-table-row"][data-task-id="task-tag-source"]')).toBeVisible();
  await expect(page.locator('[data-role="task-table-row"][data-task-id="task-tag-backend-match"]')).toBeVisible();
  await expect(page.locator('[data-role="task-table-row"][data-task-id="task-tag-frontend-other"]')).toHaveCount(0);
});

test("tasks overview shows populated draft and scheduled sections", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-scheduled-overview",
          slug: "scheduled-overview",
          name: "Scheduled Overview Flow",
          description: "Flow used to verify visible overview sections.",
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
          id: "task-draft-visible",
          projectId: "orchestra",
          number: "ORC-3",
          title: "Draft planning task",
          description: null,
          type: "task",
          status: "draft",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
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
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.task-schedules",
      JSON.stringify([
        {
          id: "schedule-nightly-triage",
          projectId: "orchestra",
          taskBlueprint: {
            title: "Nightly triage",
            description: "Review inbound requests.",
            type: "task",
            status: "ready",
            priority: "P2",
            workflowId: "workflow-scheduled-overview",
            currentLaneId: null,
            assigneeType: "unassigned",
            assigneeId: null,
            repositoryId: null,
            repositoryIds: [],
            parentTaskId: null,
            whipMaxAttempts: 10,
            archived: false,
          },
          enabled: true,
          oneShot: false,
          overlapPolicy: "skip",
          trigger: { type: "time", kind: "daily", timeOfDay: "09:00", timezone: "UTC" },
          nextFireAt: null,
          lastFiredAt: null,
          lastMaterializedTaskId: null,
          lastError: null,
          occurrences: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft planning task");
  await expect(page.locator('[data-role="task-schedule-section"]')).toContainText("Nightly triage");
  await expect(page.locator('[data-role="task-schedule-card"]')).toHaveCount(1);
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "false");
});

test("task create and detail flows support free-form tags with inline validation and keyboard removal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();

  await page.locator('[data-role="task-title"]').fill("Tagged task");

  const tagInput = page.locator('[data-role="task-tags-input"]');
  const editableTags = page.locator('[data-role="task-tags-field"] [data-role="task-tag-chip"]');

  await tagInput.fill("Backend");
  await tagInput.press("Enter");
  await tagInput.fill("api");
  await tagInput.press("Enter");
  await expect(editableTags).toHaveCount(2);
  await expect(editableTags.nth(0)).toContainText("api");
  await expect(editableTags.nth(1)).toContainText("backend");

  await tagInput.fill("Backend");
  await tagInput.press("Enter");
  await expect(editableTags).toHaveCount(2);
  await expect(page.locator('[data-role="task-tags-error"]')).toHaveCount(0);

  await tagInput.fill("bad tag");
  await tagInput.press("Enter");
  await expect(page.locator('[data-role="task-tags-error"]')).toContainText("Tags must use lower-case letters");
  await expect(editableTags).toHaveCount(2);

  await tagInput.fill("frontend");
  await tagInput.press("Enter");
  await expect(page.locator('[data-role="task-tags-error"]')).toHaveCount(0);
  await expect(editableTags).toHaveCount(3);

  await page.locator('[data-role="save-task"]').click();

  const titleTags = page.locator('[data-role="task-title-tags"] [data-role="task-tag-chip"]');
  await expect(page.locator('[data-role="task-overview-tags"]')).toHaveCount(0);
  await expect(titleTags).toHaveCount(3);
  await expect(titleTags.nth(0)).toContainText("api");
  await expect(titleTags.nth(1)).toContainText("backend");
  await expect(titleTags.nth(2)).toContainText("frontend");

  await page.locator('[data-role="edit-task"]').click();
  await tagInput.click();
  await tagInput.press("Backspace");
  await expect(page.locator('[data-role="task-tag-chip-focus"][data-tag-value="frontend"]')).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(editableTags).toHaveCount(2);

  await tagInput.fill("OPS");
  await tagInput.press("Enter");
  await expect(editableTags).toHaveCount(3);
  await expect(editableTags.nth(2)).toContainText("ops");

  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="close-edit-task"]').click();

  await expect(page.locator('[data-role="task-overview-tags"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-title-tags"] [data-role="task-tag-chip"]').nth(0)).toContainText("api");
  await expect(page.locator('[data-role="task-title-tags"] [data-role="task-tag-chip"]').nth(1)).toContainText("backend");
  await expect(page.locator('[data-role="task-title-tags"] [data-role="task-tag-chip"]').nth(2)).toContainText("ops");
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
  laneSummaries: [],
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
  laneSummaries: [],
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
  await expect(page.locator('[data-role="task-table"] thead th')).toHaveText(["Name", "Priority", "Status", "Tags", "Lane", "Assignee", "Comments"]);
  await expect(page.getByRole("columnheader", { name: "Workflow" })).toHaveCount(0);
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

test("queued assignment badges do not replace lifecycle status badges in card and table views", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-status-badges",
          slug: "status-badges",
          name: "Status Badge Flow",
          description: "Verify lifecycle and queue badges stay separate.",
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
          id: "task-queued-in-progress",
          projectId: "orchestra",
          number: "ORC-21",
          title: "Queued in-progress task",
          description: null,
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: "workflow-status-badges",
          currentLaneId: "lane-implement",
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: {
            id: "assignment-queued-in-progress",
            taskId: "task-queued-in-progress",
            workflowId: "workflow-status-badges",
            laneId: "lane-implement",
            workerType: "role",
            workerId: "developer",
            status: "queued",
            sessionId: null,
            runtimeCwd: null,
            roleQueueEntryId: "queue-queued-in-progress",
            roleInstanceId: null,
            prompt: "Implement it.",
            pendingOutcome: null,
            completionNotes: null,
            whipCount: 0,
            lastWhipAt: null,
            startedAt: timestamp,
            completedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-queued-blocked",
          projectId: "orchestra",
          number: "ORC-22",
          title: "Queued blocked task",
          description: null,
          type: "task",
          status: "blocked",
          priority: "P2",
          workflowId: "workflow-status-badges",
          currentLaneId: "lane-implement",
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: {
            id: "assignment-queued-blocked",
            taskId: "task-queued-blocked",
            workflowId: "workflow-status-badges",
            laneId: "lane-implement",
            workerType: "role",
            workerId: "developer",
            status: "queued",
            sessionId: null,
            runtimeCwd: null,
            roleQueueEntryId: "queue-queued-blocked",
            roleInstanceId: null,
            prompt: "Investigate the blocker.",
            pendingOutcome: null,
            completionNotes: null,
            whipCount: 0,
            lastWhipAt: null,
            startedAt: timestamp,
            completedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  const inProgressCard = page.locator('[data-role="task-card"][data-task-id="task-queued-in-progress"]').first();
  const blockedCard = page.locator('[data-role="task-card"][data-task-id="task-queued-blocked"]').first();

  await expect(inProgressCard.locator('[data-role="task-lifecycle-status-badge"]').first()).toHaveText("in progress");
  await expect(inProgressCard.locator('[data-role="task-assignment-status-badge"]').first()).toHaveText("queued");
  await expect(blockedCard.locator('[data-role="task-lifecycle-status-badge"]').first()).toHaveText("blocked");
  await expect(blockedCard.locator('[data-role="task-assignment-status-badge"]').first()).toHaveText("queued");
  await expect(inProgressCard.locator('[data-role="task-lifecycle-status-badge"]').first()).not.toHaveText("queued");
  await expect(blockedCard.locator('[data-role="task-lifecycle-status-badge"]').first()).not.toHaveText("queued");

  await page.locator('[data-role="task-view-table"]').click();

  const inProgressRow = page.locator('[data-role="task-table-row"][data-task-id="task-queued-in-progress"]');
  const blockedRow = page.locator('[data-role="task-table-row"][data-task-id="task-queued-blocked"]');

  await expect(inProgressRow.locator('[data-role="task-lifecycle-status-badge"]')).toHaveText("in progress");
  await expect(inProgressRow.locator('[data-role="task-assignment-status-badge"]')).toHaveText("queued");
  await expect(blockedRow.locator('[data-role="task-lifecycle-status-badge"]')).toHaveText("blocked");
  await expect(blockedRow.locator('[data-role="task-assignment-status-badge"]')).toHaveText("queued");
  await expect(inProgressRow.locator('[data-role="task-lifecycle-status-badge"]')).not.toHaveText("queued");
  await expect(blockedRow.locator('[data-role="task-lifecycle-status-badge"]')).not.toHaveText("queued");
});

test("tasks overview filters and sorts by tags and renders compact tags across cards and table rows", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-tags",
          slug: "tags",
          name: "Tagged Flow",
          description: "Single lane for task tags.",
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
          id: "task-backend",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Backend only task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T10:00:00.000Z",
        },
        {
          id: "task-urgent",
          projectId: "orchestra",
          number: "ORC-2",
          title: "Urgent only task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["urgent"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T11:00:00.000Z",
        },
        {
          id: "task-mixed",
          projectId: "orchestra",
          number: "ORC-3",
          title: "Mixed tagged task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend", "ops", "qa", "urgent"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T12:00:00.000Z",
        },
        {
          id: "task-untagged",
          projectId: "orchestra",
          number: "ORC-4",
          title: "Untagged task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P3",
          workflowId: "workflow-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: [],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T13:00:00.000Z",
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("No active filters");
  await setTaskOverviewFiltersExpanded(page, true);

  await expect(page.locator('[data-role="task-tag-filters"]')).toContainText("#backend");
  await page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]').click();
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Backend only task");
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Mixed tagged task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Urgent only task");

  await page.locator('[data-role="task-tag-filter-chip"][data-tag="urgent"]').click();
  await expect(page.locator('[data-role="task-tag-match-all"]')).toBeEnabled();
  await page.locator('[data-role="task-tag-match-all"]').click();
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Mixed tagged task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Backend only task");
  await expect(page.locator('[data-role="task-card"]').filter({ hasText: "Mixed tagged task" }).locator('[data-role="task-tag-overflow"]')).toContainText("+2");

  await page.locator('[data-role="task-clear-tags"]').click();
  await page.locator('[data-role="task-view-table"]').click();
  await page.locator('[data-role="task-sort-field"]').selectOption("tags");
  await page.locator('[data-role="task-sort-direction"]').selectOption("asc");

  await expect(page.locator('[data-role="task-table"]')).toBeVisible();
  await expect(page.locator('[data-role="task-table-row"]').last()).toContainText("Untagged task");
  await expect(page.locator('[data-role="task-table-row"]').filter({ hasText: "Untagged task" })).toContainText("—");
  await expect(page.locator('[data-role="task-table-row"]').filter({ hasText: "Mixed tagged task" }).locator('[data-role="task-tag-list"]')).toContainText("#backend");
  await expect(page.locator('[data-role="task-table-row"]').filter({ hasText: "Mixed tagged task" }).locator('[data-role="task-tag-overflow"]')).toContainText("+1");
  await expect.poll(async () =>
    page.evaluate(() => window.localStorage.getItem("orchestra.preferences.task-overview.v1.orchestra"))
  ).toContain('"sort":{"field":"tags","direction":"asc"}');

  const secondPage = await page.context().newPage();
  await secondPage.goto("/");
  await secondPage.getByRole("button", { name: "Tasks" }).click();
  await expect(secondPage.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect(secondPage.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "true");
  await expect(secondPage.locator('[data-role="task-sort-field"]')).toHaveValue("tags");
  await expect(secondPage.locator('[data-role="task-sort-direction"]')).toHaveValue("asc");
  await secondPage.close();
});

test("tasks overview limits tag filter chips to tags from currently visible tasks", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-visible-tags",
          slug: "visible-tags",
          name: "Visible Tag Flow",
          description: "Flow used to verify tag filter derivation.",
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
          id: "task-backend-ready",
          projectId: "orchestra",
          number: "ORC-20",
          title: "Backend ready task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-visible-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["backend"],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T10:00:00.000Z",
        },
        {
          id: "task-frontend-blocked",
          projectId: "orchestra",
          number: "ORC-21",
          title: "Frontend blocked task",
          description: null,
          type: "task",
          status: "blocked",
          priority: "P2",
          workflowId: "workflow-visible-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["frontend"],
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
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T11:00:00.000Z",
        },
        {
          id: "task-completed-hidden",
          projectId: "orchestra",
          number: "ORC-22",
          title: "Completed hidden task",
          description: null,
          type: "task",
          status: "completed",
          priority: "P3",
          workflowId: "workflow-visible-tags",
          currentLaneId: null,
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: ["done-only"],
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
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T12:00:00.000Z",
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await setTaskOverviewFiltersExpanded(page, true);

  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toBeVisible();
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="frontend"]')).toBeVisible();
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="done-only"]')).toHaveCount(0);

  await page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]').click();
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Backend ready task");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Frontend blocked task");
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toBeVisible();
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="frontend"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="done-only"]')).toHaveCount(0);

  await page.locator('[data-role="task-clear-tags"]').click();
  await page.locator('[data-role="task-filter-done"]').click();
  await expect(page.locator('[data-role="workflow-done-grid"]')).toContainText("Completed hidden task");
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="done-only"]')).toBeVisible();
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="backend"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-tag-filter-chip"][data-tag="frontend"]')).toHaveCount(0);
});

test("tasks overview keeps stale persisted tag filters clearable when current tasks have no tags", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-stale-tags",
          slug: "stale-tags",
          name: "Stale Tag Flow",
          description: "Tasks without current tags.",
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
          id: "task-stale-1",
          projectId: "orchestra",
          number: "ORC-10",
          title: "Visible after clearing stale tags",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-stale-tags",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          tags: [],
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T09:00:00.000Z",
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.preferences.task-overview.v1.orchestra",
      JSON.stringify({
        boardFilter: "all",
        viewMode: "cards",
        sort: { field: "updatedAt", direction: "desc" },
        tags: ["backend"],
        tagMatch: "any",
      }),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="workflow-task-section"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-overview-filters-toggle"]')).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-role="task-overview-filters-summary"]')).toContainText("Tags: #backend");

  await setTaskOverviewFiltersExpanded(page, true);
  await expect(page.locator('[data-role="task-tag-filters"]')).toContainText("#backend");
  await expect(page.locator('[data-role="task-tag-filter-note"]')).toContainText("#backend");
  await expect(page.locator('[data-role="task-clear-tags"]')).toBeEnabled();

  await page.locator('[data-role="task-clear-tags"]').click();

  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Visible after clearing stale tags");
  await expect.poll(async () =>
    page.evaluate(() => window.localStorage.getItem("orchestra.preferences.task-overview.v1.orchestra"))
  ).toContain('"tags":[]');
  await expect(page.locator('[data-role="task-tag-filters"]')).toHaveCount(0);
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
  laneSummaries: [],
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
  laneSummaries: [],
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
  laneSummaries: [],
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
  await page.locator('[data-role="project-detail-tab-automation"]').click();
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
  await expect(page.getByText("This task is currently blocked by unresolved dependencies or unfinished subtasks and is not dispatchable.", { exact: true })).toBeVisible();
});

test("task detail toggles between dependency list and tree views", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-upstream",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Foundation blocker",
          description: null,
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
          commentCount: 0,
          unreadCommentCount: 0,
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-blocker",
          projectId: "orchestra",
          number: "ORC-2",
          title: "API blocker",
          description: null,
          type: "task",
          status: "blocked",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
          laneRunCount: 0,
          childCount: 0,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 1,
          blockingCount: 1,
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-selected",
          projectId: "orchestra",
          number: "ORC-3",
          title: "Selected task",
          description: null,
          type: "feature",
          status: "ready",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
          laneRunCount: 0,
          childCount: 1,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 1,
          blockingCount: 1,
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-child",
          projectId: "orchestra",
          number: "ORC-4",
          title: "UI follow-up",
          description: null,
          type: "task",
          status: "ready",
          priority: "P3",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: "task-selected",
          archived: false,
          commentCount: 0,
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
  laneSummaries: [],
          activeLaneAssignment: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-blocked",
          projectId: "orchestra",
          number: "ORC-5",
          title: "Release task",
          description: null,
          type: "task",
          status: "blocked",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.task-dependencies",
      JSON.stringify([
        {
          id: "dependency-upstream-blocker",
          blockerTaskId: "task-upstream",
          blockedTaskId: "task-blocker",
          createdAt: timestamp,
        },
        {
          id: "dependency-blocker-selected",
          blockerTaskId: "task-blocker",
          blockedTaskId: "task-selected",
          createdAt: timestamp,
        },
        {
          id: "dependency-selected-blocked",
          blockerTaskId: "task-selected",
          blockedTaskId: "task-blocked",
          createdAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Selected task" }).first().click();
  await page.locator('[data-role="task-detail-tab-dependencies"]').click();

  await expect(page.locator('[data-role="task-dependency-view-list"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-role="task-dependency-list"]')).toBeVisible();
  await expect(page.locator('[data-role="task-blocked-by"]')).toContainText("ORC-2 · API blocker");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toHaveCount(0);

  await page.locator('[data-role="task-dependency-view-tree"]').click();

  await expect(page.locator('[data-role="task-dependency-view-tree"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toBeVisible();
  await expect(page.locator('[data-role="task-dependency-tree-root"]')).toContainText("ORC-3 · Selected task");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("Blocked by");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("ORC-2 · API blocker");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("ORC-1 · Foundation blocker");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("Subtasks");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("ORC-4 · UI follow-up");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("Blocking");
  await expect(page.locator('[data-role="task-dependency-tree"]')).toContainText("ORC-5 · Release task");

  await page.locator('[data-role="task-dependency-view-list"]').click();
  await expect(page.locator('[data-role="task-dependency-view-list"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-role="task-dependency-list"]')).toBeVisible();
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
  laneSummaries: [],
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

test("task detail opens tracked repo files when clicking $file mentions in comments", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  await page.locator('[data-role="project-detail-tab-repositories"]').click();
  await page.locator('[data-role="repository-name"]').fill("Docs repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/docs-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();
  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Docs repo");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Comment mention link task");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-detail-tab-repo-files"]').click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toContainText("No tracked repo files yet.");
  await expect(page.locator('[data-role="task-file-reference-repository"]')).toHaveValue(/repo-/);

  await page.locator('[data-role="task-detail-tab-todos"]').click();
  await expect(page.locator('[data-role="task-detail-tabpanel-todos"]')).toContainText("No todos yet.");

  await page.locator('[data-role="task-detail-tab-attachments"]').click();
  await expect(page.locator('[data-role="task-detail-tabpanel-attachments"]')).toContainText("No attachments yet.");

  await page.locator('[data-role="task-detail-tab-repo-files"]').click();
  await page.locator('[data-role="task-file-reference-path"]').fill("docs/design.md");
  await page.locator('[data-role="add-task-file-reference"]').click();
  await expect(page.locator('[data-role="task-file-references"]')).toContainText("docs/design.md");

  await revealTaskDetailDock(page);
  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Please review $docs/design.md before you continue.");
  await page.locator('[data-role="add-task-comment"]').click();

  await page.locator('[data-role="task-comment-mention-link"]').first().click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();
  await expect(page.locator('[data-role="selected-task-file-reference-card"]')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const select = document.querySelector('[data-role="task-file-references"] select');
    const card = document.querySelector('[data-role="selected-task-file-reference-card"]');
    const cardTop = card instanceof HTMLElement ? card.getBoundingClientRect().top : null;
    return {
      selectedLabel: select instanceof HTMLSelectElement ? select.options[select.selectedIndex]?.textContent ?? "" : "",
      cardVisibleInViewport: cardTop !== null && cardTop < window.innerHeight,
    };
  })).toMatchObject({
    selectedLabel: expect.stringContaining("docs/design.md"),
    cardVisibleInViewport: true,
  });
});

test("task comment composer autocompletes tasks, agents, and roles and renders task mentions as links", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Reviewer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Mention target task");
  await page.locator('[data-role="save-task"]').click();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Mention source task");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");

  await page.locator('[data-role="task-comment-message"]').fill("Coordinate with @dat");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("Data");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("Agent · data");

  await page.locator('[data-role="task-comment-message"]').fill("Ask @rev");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("Role · reviewer");

  await page.locator('[data-role="task-comment-message"]').fill("Please review @target");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("Mention target task");
  await page.locator('[data-role="task-comment-mention-option"]').filter({ hasText: "Mention target task" }).click();
  await expect(page.locator('[data-role="task-comment-message"]')).toHaveValue(/Please review @ORC-\d+\s/);

  await page.locator('[data-role="add-task-comment"]').click();
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Mention target task");

  await page.locator('[data-role="task-comment-mention-link"]').filter({ hasText: "Mention target task" }).first().click();
  await expect(page.getByRole("heading", { name: "Mention target task" })).toBeVisible();
});

test("task comment composer autocompletes canonical project tags", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Project tag source");
  await page.locator('[data-role="task-tags-input"]').fill("BackEnd");
  await page.locator('[data-role="task-tags-input"]').press("Enter");
  await page.locator('[data-role="task-tags-input"]').fill("ops");
  await page.locator('[data-role="task-tags-input"]').press("Enter");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="nav-item-tasks"]').click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Comment tag source");
  await page.locator('[data-role="task-tags-input"]').fill("Urgent");
  await page.locator('[data-role="task-tags-input"]').press("Enter");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");

  const taskCommentMessage = page.locator('[data-role="task-comment-message"]');

  await taskCommentMessage.fill("");
  await taskCommentMessage.click();
  await page.keyboard.type("#");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("#urgent");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("#backend");
  await expect(page.locator('[data-role="task-comment-mention-option"]').first()).toContainText("#urgent");

  await taskCommentMessage.fill("");
  await taskCommentMessage.click();
  await page.keyboard.type("Reuse #backend and add #bac");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toContainText("#backend");
  await page.locator('[data-role="task-comment-mention-option"]').filter({ hasText: "#backend" }).click();
  await expect(taskCommentMessage).toHaveValue("Reuse #backend and add #backend ");

  await taskCommentMessage.fill("");
  await taskCommentMessage.click();
  await page.keyboard.type("#backend");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toHaveCount(0);

  await taskCommentMessage.fill("");
  await taskCommentMessage.click();
  await page.keyboard.type("#zzz");
  await expect(page.locator('[data-role="task-comment-mention-list"]')).toHaveCount(0);
});

test("task comments show newest threads first", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Comment ordering task");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("First comment");
  await page.locator('[data-role="add-task-comment"]').click();

  await page.waitForTimeout(25);
  await page.locator('[data-role="task-comment-message"]').fill("Second comment");
  await page.locator('[data-role="add-task-comment"]').click();

  const comments = page.locator('[data-role="task-comments"] [data-role="task-comment-item"]');
  await expect(comments).toHaveCount(2);
  await expect(comments.first()).toContainText("Second comment");
  await expect(comments.nth(1)).toContainText("First comment");
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
          description: "First line\nSecond line with **bold** text\n\n1. Step one\n2. Step two",
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
              message: "First review line\nSecond review line with **important** context\n\n1. Check API shape\n2. Confirm UI",
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
  laneSummaries: [],
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
  await expect(page.locator('[data-role="task-description-markdown"] ol li').nth(1)).toHaveAttribute("value", "2");
  const descriptionHtml = await page.locator('[data-role="task-description-markdown"]').evaluate((node) => node.innerHTML);
  expect(descriptionHtml).toContain("<br");
  expect(descriptionHtml).toContain("<ol");

  const detailedComment = page.locator('[data-role="task-detail-summary-comments"] [data-role="task-comment-markdown"]').first();
  await expect(detailedComment).toContainText("First review line");
  await expect(detailedComment).toContainText("Second review line with important context");
  await expect(page.locator('[data-role="task-detail-summary-comments"] [data-role="task-comment-markdown"] strong')).toContainText("important");
  await expect(page.locator('[data-role="task-detail-summary-comments"] [data-role="task-comment-markdown"] li')).toHaveCount(2);
  await expect(page.locator('[data-role="task-detail-summary-comments"] [data-role="task-comment-markdown"] ol li').nth(1)).toHaveAttribute("value", "2");
  const commentHtml = await detailedComment.evaluate((node) => node.innerHTML);
  expect(commentHtml).toContain("<br");
  expect(commentHtml).toContain("<ol");
});

test("task comment reply actions scroll/focus composer and nested replies target the top-level thread", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const buildComment = (id: string, parentCommentId: string | null, author: string, message: string, offset: number) => ({
      id,
      taskId: "task-reply-scroll-focus",
      parentCommentId,
      author,
      message,
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
      createdAt: new Date(Date.parse(timestamp) + offset).toISOString(),
      updatedAt: new Date(Date.parse(timestamp) + offset).toISOString(),
    });
    const comments = [
      buildComment("thread-parent", null, "Reviewer", "Top-level thread that needs reply focus.", 0),
      ...Array.from({ length: 18 }, (_, index) => buildComment(
        `thread-reply-${index + 1}`,
        "thread-parent",
        "Worker",
        `Nested reply ${index + 1} with enough thread content to push the inline composer away from the clicked action.`,
        (index + 1) * 1000,
      )),
    ];

    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-reply-scroll-focus",
          projectId: "orchestra",
          number: "ORC-301",
          title: "Reply scroll focus task",
          description: "Verify reply buttons move focus to the inline reply composer.",
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
          taskRepositories: [],
          fileReferences: [],
          comments,
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Reply scroll focus task" }).first().click();

  const topLevelReplyButton = page.locator('[data-role="reply-task-comment"][data-comment-id="thread-parent"]');
  await expect(topLevelReplyButton).toBeVisible();
  await topLevelReplyButton.click();

  const replyMessage = page.locator('[data-role="task-reply-message"]');
  await expect(replyMessage).toBeVisible();
  await expect(replyMessage).toBeFocused();
  await expect.poll(() => replyMessage.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);

  await page.locator('[data-role="cancel-task-reply"]').click();
  await expect(replyMessage).toHaveCount(0);

  const nestedReplyButton = page
    .locator('[data-role="task-comment-reply"]')
    .filter({ hasText: "Nested reply 1" })
    .locator('[data-role="reply-task-comment"][data-comment-id="thread-reply-1"]');
  await expect(nestedReplyButton).toBeVisible();
  await expect(nestedReplyButton).toHaveAttribute("data-parent-comment-id", "thread-parent");
  await nestedReplyButton.click();

  await expect(replyMessage).toBeVisible();
  await expect(replyMessage).toBeFocused();
  await expect.poll(() => replyMessage.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);

  await replyMessage.fill("Reply from a nested comment button.");
  await replyMessage.press("Control+Enter");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reply from a nested comment button.");
  await expect.poll(() => page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]") as Array<{ id: string; comments: Array<{ message: string; parentCommentId?: string | null }> }>;
    const task = tasks.find((entry) => entry.id === "task-reply-scroll-focus");
    return task?.comments.find((comment) => comment.message === "Reply from a nested comment button.")?.parentCommentId ?? null;
  })).toBe("thread-parent");
});

test("task comment and reply composers handle heavy threaded markdown histories across layouts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = Date.parse(new Date().toISOString());
    const buildComment = (id: string, parentCommentId: string | null, author: string, message: string, offset: number) => ({
      id,
      taskId: "task-heavy-comment-history",
      parentCommentId,
      author,
      message,
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
      createdAt: new Date(timestamp + offset).toISOString(),
      updatedAt: new Date(timestamp + offset).toISOString(),
    });
    const comments = Array.from({ length: 12 }, (_, index) => {
      const threadId = `thread-${index + 1}`;
      const threadOffset = index * 10_000;
      return [
        buildComment(
          threadId,
          null,
          "Reviewer",
          `### Thread ${index + 1}\n- Checklist item A\n- Checklist item B\n\n\`\`\`ts\nconst thread = ${index + 1};\n\`\`\``,
          threadOffset,
        ),
        buildComment(
          `${threadId}-reply-1`,
          threadId,
          "Worker",
          `Reply ${index + 1}.1 with additional context and multiline markdown.\n\n1. First follow-up\n2. Second follow-up`,
          threadOffset + 1_000,
        ),
        buildComment(
          `${threadId}-reply-2`,
          threadId,
          "Worker",
          `Reply ${index + 1}.2 keeps the thread warm while we test typing responsiveness.`,
          threadOffset + 2_000,
        ),
      ];
    }).flat();

    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-heavy-comment-history",
          projectId: "orchestra",
          number: "ORC-302",
          title: "Heavy comment history task",
          description: "Exercise top-level and reply typing against a large markdown thread history.",
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
          unreadCommentCount: 0,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments,
          todos: [],
          laneRuns: [],
          laneSummaries: [],
          tags: [],
          activeLaneAssignment: null,
          createdAt: new Date(timestamp).toISOString(),
          updatedAt: new Date(timestamp).toISOString(),
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Heavy comment history task" }).first().click();

  const topLevelComment = page.locator('[data-role="task-comment-message"]');
  const longTopLevelComment = "Wide-layout multiline typing check.\nSecond line keeps the draft in the conversation component.\n- Bullet one\n- Bullet two";
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await topLevelComment.click();
  await topLevelComment.pressSequentially(longTopLevelComment);
  await expect(topLevelComment).toHaveValue(longTopLevelComment);
  await page.locator('[data-role="add-task-comment"]').click();
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Wide-layout multiline typing check.");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Second line keeps the draft in the conversation component.");
  await expect(topLevelComment).toHaveValue("");

  await page.setViewportSize({ width: 780, height: 760 });
  await revealTaskDetailDock(page);
  const nestedReplyButton = page.locator('[data-role="reply-task-comment"][data-comment-id="thread-3-reply-1"]');
  await expect(nestedReplyButton).toBeVisible();
  await nestedReplyButton.click();

  const replyAuthor = page.locator('[data-role="task-reply-author"]');
  const replyMessage = page.locator('[data-role="task-reply-message"]');
  const longReply = "Narrow-layout reply typing check.\nThis reply should stay responsive with the heavy history still mounted.";
  await replyAuthor.fill("Worker");
  await replyMessage.click();
  await replyMessage.pressSequentially(longReply);
  await expect(replyMessage).toHaveValue(longReply);
  await replyMessage.press("Control+Enter");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Narrow-layout reply typing check.");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("This reply should stay responsive with the heavy history still mounted.");
  await expect.poll(() => page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]") as Array<{ id: string; comments: Array<{ message: string; parentCommentId?: string | null }> }>;
    const task = tasks.find((entry) => entry.id === "task-heavy-comment-history");
    return task?.comments.find((comment) => comment.message === "Narrow-layout reply typing check.\nThis reply should stay responsive with the heavy history still mounted.")?.parentCommentId ?? null;
  })).toBe("thread-3");
});

test("task detail supports attachments, comments, recent activity, and review inbox filtering", async ({ page }) => {
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
    {
      name: "meeting.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("RIFF-WAVE"),
    },
    {
      name: "bundle.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PK\u0003\u0004zip"),
    },
  ]);

  await expect(page.locator('[data-role="task-attachments"]')).toContainText("notes.txt");
  await expect(page.locator('[data-role="task-attachments"]')).toContainText("pixel.png");
  await expect(page.locator('[data-role="task-attachments"]')).toContainText("meeting.wav");
  await expect(page.locator('[data-role="task-attachments"]')).toContainText("bundle.zip");
  await expect(page.locator('.task-attachment-card__text')).toContainText("Attachment preview text");
  await expect(page.locator('.task-attachment-card__image')).toHaveCount(1);
  await expect(page.locator('[data-role="task-attachment-fallback"][data-attachment-kind="audio"]')).toContainText("Audio attachment");
  await expect(page.locator('[data-role="task-attachment-fallback"][data-attachment-kind="archive"]')).toContainText("Archive attachment");

  const downloadPromise = page.waitForEvent("download");
  await page
    .locator('.task-attachment-card', { hasText: 'notes.txt' })
    .locator('[data-role="download-task-attachment"]')
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("notes.txt");
  expect(await readFile((await download.path())!, "utf8")).toBe("Attachment preview text");

  await revealTaskDetailDock(page);
  await page.locator('[data-role="task-detail-tab-summary"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Pause and re-check the task context before you continue.");
  await page.locator('[data-role="task-comment-interrupt"]').check();
  await page.locator('[data-role="task-comment-message"]').press("Control+Enter");

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");

  await page.locator('[data-role="reply-task-comment"]').first().click();
  await page.locator('[data-role="task-reply-author"]').fill("Worker");
  await page.locator('[data-role="task-reply-message"]').fill("I checked the task context and updated the plan.");
  await page.locator('[data-role="task-reply-message"]').press("Control+Enter");

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Worker");
  await expect(page.locator('[data-role="task-comment-reply"]')).toContainText("I checked the task context and updated the plan.");

  const recentHistory = page.locator('.task-detail-summary__history-list');
  await expect(recentHistory).toContainText("Attachment added: bundle.zip");
  await expect(recentHistory).toContainText("Reviewer commented");
  await expect(recentHistory).toContainText("Worker replied");

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

test("task attachment downloads preserve filenames and contents in browser mode", async ({ page }, testInfo) => {
  const textPayload = Buffer.from("Download me from Orchestra.");
  const archivePayload = Buffer.from([80, 75, 3, 4, 20, 0, 255, 42, 7]);

  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();
  await page.locator('[data-role="task-detail-tab-attachments"]').click();
  await page.locator('[data-role="task-attachment-input"]').setInputFiles([
    {
      name: "download-notes.txt",
      mimeType: "text/plain",
      buffer: textPayload,
    },
    {
      name: "archive.zip",
      mimeType: "application/zip",
      buffer: archivePayload,
    },
  ]);

  const [textDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".task-attachment-card").filter({ hasText: "download-notes.txt" }).locator('[data-role="download-task-attachment"]').click(),
  ]);
  expect(textDownload.suggestedFilename()).toBe("download-notes.txt");
  const textDownloadPath = testInfo.outputPath("download-notes.txt");
  await textDownload.saveAs(textDownloadPath);
  expect(await readFile(textDownloadPath, "utf8")).toBe(textPayload.toString("utf8"));

  const [binaryDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".task-attachment-card").filter({ hasText: "archive.zip" }).locator('[data-role="download-task-attachment"]').click(),
  ]);
  expect(binaryDownload.suggestedFilename()).toBe("archive.zip");
  const binaryDownloadPath = testInfo.outputPath("archive.zip");
  await binaryDownload.saveAs(binaryDownloadPath);
  expect(await readFile(binaryDownloadPath)).toEqual(archivePayload);
});

test("task comment unread badges hide on completed tasks but still clear for active tasks when comments are opened", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-comment-unread",
          slug: "comment-unread",
          name: "Comment Unread Flow",
          description: "User-owned lane for unread comment badge coverage.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-user-review",
              key: "user-review",
              name: "User review",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: null,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
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
          id: "task-comment-unread-active",
          projectId: "orchestra",
          number: "ORC-7",
          title: "Unread active task comments",
          description: "Unread comment badge coverage for active work.",
          type: "task",
          status: "in_review",
          priority: "P1",
          workflowId: "workflow-comment-unread",
          currentLaneId: "lane-user-review",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 2,
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
              id: "comment-agent-active",
              taskId: "task-comment-unread-active",
              author: "Reviewer",
              originType: "agent",
              originId: "agent-reviewer",
              message: "Please update the implementation plan.",
              interruptAgent: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: "comment-user-active",
              taskId: "task-comment-unread-active",
              author: "User",
              originType: "user",
              originId: null,
              message: "Acknowledged.",
              interruptAgent: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-comment-unread-completed",
          projectId: "orchestra",
          number: "ORC-8",
          title: "Unread completed task comments",
          description: "Unread comment badge coverage for completed work.",
          type: "task",
          status: "completed",
          priority: "P2",
          workflowId: "workflow-comment-unread",
          currentLaneId: "lane-user-review",
          assigneeType: "user",
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
              id: "comment-agent-completed",
              taskId: "task-comment-unread-completed",
              author: "Reviewer",
              originType: "agent",
              originId: "agent-reviewer",
              message: "Final follow-up after completion.",
              interruptAgent: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.task-comment-user-receipts", JSON.stringify([]));
  });

  await page.goto("/");
  await page.locator('[data-role="nav-item-tasks"]').click();
  await expect(page.locator('[data-role="nav-badge-tasks"]')).toContainText("1");
  await expect(
    page.locator('[data-role="task-card"]').filter({ hasText: "Unread active task comments" }).first().locator('[data-role="task-card-unread-comments-badge"]'),
  ).toContainText("1 unread");

  await page.locator('[data-role="task-filter-done"]').click();
  await expect(
    page.locator('[data-role="task-card"]').filter({ hasText: "Unread completed task comments" }).first().locator('[data-role="task-card-unread-comments-badge"]'),
  ).toHaveCount(0);

  await page.locator('[data-role="task-view-table"]').click();
  await expect(
    page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread completed task comments" }).locator('[data-role="task-table-unread-comments-badge"]'),
  ).toHaveCount(0);
  await page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread completed task comments" }).first().click();
  await expect(page.locator('[data-role="task-unread-comments-footer-badge"]')).toHaveCount(0);

  await page.locator('[data-role="nav-item-tasks"]').click();
  await page.locator('[data-role="task-filter-all"]').click();
  await page.locator('[data-role="task-view-table"]').click();
  await expect(
    page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread active task comments" }).locator('[data-role="task-table-unread-comments-badge"]'),
  ).toContainText("1 unread");
  await page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread active task comments" }).first().click();
  await expect(page.locator('[data-role="task-unread-comments-footer-badge"]')).toContainText('1 unread');
  await expect(page.locator('[data-role="nav-badge-tasks"]')).toContainText('1');
  await page.getByRole('button', { name: 'Comments' }).click();
  await expect(page.locator('[data-role="task-unread-comments-footer-badge"]')).toHaveCount(0);
  await expect(page.locator('[data-role="nav-badge-tasks"]')).toHaveCount(0);
});

test("task detail shows open session for active or historical task sessions and hides it when no task session exists", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.roles",
      JSON.stringify([
        {
          id: "developer",
          slug: "developer",
          name: "Developer",
          description: "Default developer role",
          provider: null,
          model: null,
          thinkingLevel: "medium",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-session-linked",
          projectId: "orchestra",
          number: "ORC-201",
          title: "Task with active session",
          description: null,
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: null,
          currentLaneId: "lane-implementation",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
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
          todos: [],
          laneRuns: [
            {
              id: "lane-run-session-linked",
              taskId: "task-session-linked",
              laneId: "lane-implementation",
              sessionId: "session-task-linked",
              sessionTitle: "Active task session",
              result: "success",
              summary: "Finished the implementation handoff.",
              notes: "Finished the implementation handoff.",
              startedAt: timestamp,
              completedAt: timestamp,
            },
          ],
          laneSummaries: [
            {
              laneId: "lane-implementation",
              laneName: "Implementation",
              summary: "Finished the implementation handoff.",
              outcome: "success",
              pending: false,
              sessionId: "session-task-linked",
              updatedAt: timestamp,
            },
          ],
          activeLaneAssignment: {
            id: "assignment-session-linked",
            taskId: "task-session-linked",
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            workerName: "Developer",
            status: "active",
            sessionId: "session-task-linked",
            sessionTitle: "Active task session",
            runtimeCwd: "/tmp/orchestra/task-session-linked",
            roleQueueEntryId: null,
            roleInstanceId: null,
            prompt: "Implement the active session task.",
            pendingOutcome: null,
            completionNotes: null,
            whipCount: 0,
            lastWhipAt: null,
            startedAt: timestamp,
            completedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-session-history",
          projectId: "orchestra",
          number: "ORC-202",
          title: "Task with historical sessions",
          description: null,
          type: "task",
          status: "completed",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
          laneRunCount: 2,
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
          laneRuns: [
            {
              id: "lane-run-session-history-1",
              taskId: "task-session-history",
              laneId: "lane-plan",
              sessionId: "session-task-history-earlier",
              sessionTitle: "Earlier task session",
              result: "success",
              notes: null,
              startedAt: timestamp,
              completedAt: timestamp,
            },
            {
              id: "lane-run-session-history-2",
              taskId: "task-session-history",
              laneId: "lane-implementation",
              sessionId: "session-task-history-latest",
              sessionTitle: "Latest task session",
              result: "success",
              notes: null,
              startedAt: timestamp,
              completedAt: timestamp,
            },
          ],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-session-missing",
          projectId: "orchestra",
          number: "ORC-203",
          title: "Task without task session history",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: null,
          currentLaneId: "lane-implementation",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
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
          comments: [],
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-task-linked",
          title: "Active task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [{ id: "session-event", kind: "assistant", message: "Ready for direct navigation.", timestamp }],
          taskId: "task-session-linked",
          taskNumber: "ORC-201",
          taskTitle: "Task with active session",
          activeTaskId: "task-session-linked",
          activeTaskNumber: "ORC-201",
          activeTaskTitle: "Task with active session",
          workerType: "role",
          workerName: "Developer",
        },
        {
          id: "session-task-history-earlier",
          title: "Earlier task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [{ id: "session-history-earlier-event", kind: "assistant", message: "Earlier historical session.", timestamp }],
          taskId: "task-session-history",
          taskNumber: "ORC-202",
          taskTitle: "Task with historical sessions",
          workerType: "role",
          workerName: "Developer",
        },
        {
          id: "session-task-history-latest",
          title: "Latest task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [{ id: "session-history-latest-event", kind: "assistant", message: "Latest historical session.", timestamp }],
          taskId: "task-session-history",
          taskNumber: "ORC-202",
          taskTitle: "Task with historical sessions",
          workerType: "role",
          workerName: "Developer",
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-session-linked");
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task with active session");
  await page.locator('[data-role="task-detail-tab-runtime"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("session-task-linked");
  await expect(page.locator('[data-role="task-runtime-session-link"]')).toBeVisible();
  await expect(page.locator('[data-role="task-open-session"]')).toBeVisible();
  await page.locator('[data-role="task-open-session"]').click();
  await expect
    .poll(async () => page.evaluate(() => window.location.search))
    .toContain("page=sessions");
  await expect
    .poll(async () => page.evaluate(() => window.location.search))
    .toContain("selectedSessionId=session-task-linked");
  await expect(
    page.locator('.session-list-link--active[data-role="session-link"]'),
  ).toHaveAttribute("data-session-id", "session-task-linked");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-task-linked");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Active task session");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-session-history");
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task with historical sessions");
  await expect(page.locator('[data-role="task-open-session"]')).toBeVisible();
  await page.locator('[data-role="task-open-session"]').click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-task-history-latest");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Latest task session");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-session-missing");
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task without task session history");
  await expect(page.locator('[data-role="task-open-session"]')).toHaveCount(0);
});

test("task detail mobile topbar actions include open session when a task session exists", async ({ page }) => {
  const timestamp = new Date().toISOString();

  await page.addInitScript((nextTimestamp) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-session-mobile-topbar",
          projectId: "orchestra",
          number: "ORC-204",
          title: "Task with mobile topbar session access",
          description: null,
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: null,
          currentLaneId: "lane-implementation",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
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
          todos: [],
          laneRuns: [
            {
              id: "lane-run-session-mobile-topbar",
              taskId: "task-session-mobile-topbar",
              laneId: "lane-implementation",
              sessionId: "session-task-mobile-topbar",
              sessionTitle: "Mobile topbar task session",
              result: "success",
              notes: null,
              startedAt: nextTimestamp,
              completedAt: nextTimestamp,
            },
          ],
          activeLaneAssignment: {
            id: "assignment-session-mobile-topbar",
            taskId: "task-session-mobile-topbar",
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            workerName: "Developer",
            status: "active",
            sessionId: "session-task-mobile-topbar",
            sessionTitle: "Mobile topbar task session",
            runtimeCwd: "/tmp/orchestra/task-session-mobile-topbar",
            roleQueueEntryId: null,
            roleInstanceId: null,
            prompt: "Implement the mobile topbar task.",
            pendingOutcome: null,
            completionNotes: null,
            whipCount: 0,
            lastWhipAt: null,
            startedAt: nextTimestamp,
            completedAt: null,
            createdAt: nextTimestamp,
            updatedAt: nextTimestamp,
          },
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-task-mobile-topbar",
          title: "Mobile topbar task session",
          status: "active",
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
          subscribed: false,
          events: [{ id: "session-mobile-topbar-event", kind: "assistant", message: "Ready from the topbar.", timestamp: nextTimestamp }],
          taskId: "task-session-mobile-topbar",
          taskNumber: "ORC-204",
          taskTitle: "Task with mobile topbar session access",
          activeTaskId: "task-session-mobile-topbar",
          activeTaskNumber: "ORC-204",
          activeTaskTitle: "Task with mobile topbar session access",
          workerType: "role",
          workerName: "Developer",
        },
      ]),
    );
  }, timestamp);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-session-mobile-topbar");
  });

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task with mobile topbar session access");
  const mobileTopbarActions = page.locator('[data-role="mobile-topbar-actions"]');
  await mobileTopbarActions.getByRole("button", { name: "Task actions" }).click();
  await expect(mobileTopbarActions.getByRole("button", { name: "Open session" })).toBeVisible();
  await mobileTopbarActions.getByRole("button", { name: "Open session" }).click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-task-mobile-topbar");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Mobile topbar task session");
});

test("task detail opens a linked session at the latest message with auto-scroll on", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const sessionId = "session-task-linked-scroll";
  const linkedTaskId = "task-session-linked-scroll";
  const seededSession = {
    id: sessionId,
    title: "Active task session",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: false,
    events: buildMockSessionEvents(80, "Task-linked event"),
    taskId: linkedTaskId,
    taskNumber: "ORC-301",
    taskTitle: "Task with active session and transcript history",
    activeTaskId: linkedTaskId,
    activeTaskNumber: "ORC-301",
    activeTaskTitle: "Task with active session and transcript history",
    workerType: "role",
    workerName: "Developer",
  };

  await page.addInitScript(({ nextTimestamp, nextLinkedTaskId, nextSession }) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: nextLinkedTaskId,
          projectId: "orchestra",
          number: "ORC-301",
          title: "Task with active session and transcript history",
          description: null,
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: null,
          currentLaneId: "lane-implementation",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
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
          todos: [],
          laneRuns: [],
  laneSummaries: [],
          activeLaneAssignment: {
            id: "assignment-session-linked-scroll",
            taskId: nextLinkedTaskId,
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            status: "active",
            sessionId: nextSession.id,
            runtimeCwd: "/tmp/orchestra/task-session-linked-scroll",
            roleQueueEntryId: null,
            roleInstanceId: null,
            prompt: "Implement the active session task.",
            pendingOutcome: null,
            completionNotes: null,
            whipCount: 0,
            lastWhipAt: null,
            startedAt: nextTimestamp,
            completedAt: null,
            createdAt: nextTimestamp,
            updatedAt: nextTimestamp,
          },
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([nextSession]));
  }, { nextTimestamp: timestamp, nextLinkedTaskId: linkedTaskId, nextSession: seededSession });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate((taskId) => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (nextTaskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.(taskId);
  }, linkedTaskId);

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task with active session and transcript history");
  await expect(page.locator('[data-role="task-open-session"]')).toBeVisible();
  await page.locator('[data-role="task-open-session"]').click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Active task session");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event immediately after task navigation", "test.task_session_entry_live_after_open");
  await expect(transcript).toContainText("Newest event immediately after task navigation");
  await expectTranscriptAutoScrollOn(transcript, toggle);
});

test("task detail reopens the latest closed historical session before navigation", async ({ page }) => {
  const timestamp = new Date().toISOString();

  await page.addInitScript((nextTimestamp) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-reopen-history-session",
          projectId: "orchestra",
          number: "ORC-302",
          title: "Task with reopenable history",
          description: null,
          type: "task",
          status: "completed",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          unreadCommentCount: 0,
          laneRunCount: 2,
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
          laneRuns: [
            {
              id: "lane-run-reopen-history-earlier",
              taskId: "task-reopen-history-session",
              laneId: "lane-plan",
              sessionId: "session-reopen-history-earlier",
              sessionTitle: "Earlier closed task session",
              result: "success",
              notes: null,
              startedAt: nextTimestamp,
              completedAt: nextTimestamp,
            },
            {
              id: "lane-run-reopen-history-latest",
              taskId: "task-reopen-history-session",
              laneId: "lane-implementation",
              sessionId: "session-reopen-history-latest",
              sessionTitle: "Latest closed task session",
              result: "success",
              notes: null,
              startedAt: nextTimestamp,
              completedAt: nextTimestamp,
            },
          ],
          activeLaneAssignment: null,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-reopen-history-earlier",
          title: "Earlier closed task session",
          status: "closed",
          listVisibility: "closed",
          messageability: "closed",
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
          subscribed: false,
          events: [{ id: "closed-earlier-event", kind: "assistant", message: "Earlier closed history.", timestamp: nextTimestamp }],
          taskId: "task-reopen-history-session",
          taskNumber: "ORC-302",
          taskTitle: "Task with reopenable history",
          workerType: "role",
          workerName: "Developer",
        },
        {
          id: "session-reopen-history-latest",
          title: "Latest closed task session",
          status: "closed",
          listVisibility: "closed",
          messageability: "closed",
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
          subscribed: false,
          events: [{ id: "closed-latest-event", kind: "assistant", message: "Latest closed history.", timestamp: nextTimestamp }],
          taskId: "task-reopen-history-session",
          taskNumber: "ORC-302",
          taskTitle: "Task with reopenable history",
          workerType: "role",
          workerName: "Developer",
        },
      ]),
    );
  }, timestamp);

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-reopen-history-session");
  });

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task with reopenable history");
  await expect(page.locator('[data-role="task-open-session"]')).toBeVisible();
  await page.locator('[data-role="task-open-session"]').click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-reopen-history-latest");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-messageable", "true");
  await expect(page.locator('[data-role="composer-input"]')).toBeEnabled();

  const reopenedSession = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.find((entry: { id: string }) => entry.id === "session-reopen-history-latest");
  });
  expect(reopenedSession.status).toBe("active");
  expect(reopenedSession.listVisibility).toBe("active");
  expect(reopenedSession.messageability).toBe("messageable");
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
  laneSummaries: [],
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
  laneSummaries: [],
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
              needsWorkTargetLaneId: null,
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

  const seedAwaitingApproval = async (assignmentStatus = "awaiting_user_approval") => {
    await page.evaluate((nextStatus) => {
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
        status: nextStatus,
        pendingOutcome: "success",
        completionNotes: null,
        updatedAt,
      };
      target.updatedAt = updatedAt;
      window.localStorage.setItem(key, JSON.stringify(tasks));
      window.dispatchEvent(new CustomEvent("orchestra:task-change", {
        detail: { taskIds: [target.id], reason: "test.seed.awaiting-approval" },
      }));
    }, assignmentStatus);
  };

  await seedAwaitingApproval("paused_by_user");
  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await expect(page.locator('[data-role="send-task-back-for-work"]').first()).toBeVisible();
  await expect(page.locator('[data-role="resume-task-lane"]')).toHaveCount(0);
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

  await seedAwaitingApproval("awaiting_user_intervention");
  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await expect(page.locator('[data-role="resume-task-lane"]')).toHaveCount(0);
  await page.locator('[data-role="approve-task-lane"]').first().click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane lane-agent-approval completed");
  expect(initialSessionId).toContain("Session:");
});

test("task detail sends approval-paused work to a configured Needs Work lane", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-review-return",
          slug: "review-return-flow",
          name: "Review Return Flow",
          description: "Approval-paused work can return to a configured lane.",
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
              needsWorkTargetLaneId: "lane-review-pass",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
            {
              id: "lane-review-pass",
              key: "review-pass",
              name: "Review pass",
              description: null,
              order: 1,
              assignedEntityType: "agent",
              assignedEntityId: "reviewer",
              entryPromptTemplate: "Fix the task after review feedback.",
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
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
  await page.locator('[data-role="task-title"]').fill("Configured needs work task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-review-return");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  const initialSessionId = await page.locator('[data-role="task-runtime-assignment"]').textContent();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Configured needs work task");
    if (!target?.activeLaneAssignment) {
      throw new Error("Expected active lane assignment for configured needs-work task");
    }
    const updatedAt = new Date().toISOString();
    target.status = "in_review";
    target.assigneeType = "user";
    target.assigneeId = null;
    target.activeLaneAssignment = {
      ...target.activeLaneAssignment,
      status: "awaiting_user_approval",
      pendingOutcome: "success",
      completionNotes: "Needs a dedicated review pass.",
      updatedAt,
    };
    target.updatedAt = updatedAt;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: { taskIds: [target.id], reason: "test.seed.awaiting-approval" },
    }));
  });

  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await page.locator('[data-role="send-task-back-for-work"]').first().click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("lane-review-pass");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("active");

  const relanedTask = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((entry: { title?: string }) => entry.title === "Configured needs work task");
  });

  expect(relanedTask.currentLaneId).toBe("lane-review-pass");
  expect(relanedTask.status).toBe("in_progress");
  expect(relanedTask.activeLaneAssignment?.laneId).toBe("lane-review-pass");
  expect(relanedTask.activeLaneAssignment?.sessionId).toBeTruthy();
  expect(relanedTask.activeLaneAssignment?.sessionId).not.toBe(initialSessionId?.replace(/^Session:\s*/, ""));
  expect(relanedTask.laneRuns?.[0]?.result).toBe("failure");
});

test("task detail resumes a lane paused for user intervention", async ({ page }) => {
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
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
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
  await page.locator('[data-role="task-title"]').fill("User intervention task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "User intervention task");
    if (!target?.activeLaneAssignment) {
      throw new Error("Expected active lane assignment for user intervention task");
    }
    const updatedAt = new Date().toISOString();
    target.status = "in_review";
    target.assigneeType = "user";
    target.assigneeId = null;
    target.activeLaneAssignment = {
      ...target.activeLaneAssignment,
      status: "awaiting_user_intervention",
      pendingOutcome: "needs_user",
      completionNotes: "Need an answer from the user before continuing.",
      updatedAt,
    };
    target.updatedAt = updatedAt;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: { taskIds: [target.id], reason: "test.seed.awaiting-user-intervention" },
    }));
  });

  await expect(page.locator('[data-role="resume-task-lane"]').first()).toBeVisible();
  await expect(page.locator('[data-role="task-awaiting-user-intervention-note"]').first()).toContainText("paused until you decide how to continue it");

  await page.locator('[data-role="resume-task-lane"]').first().click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("active");
  await expect(page.locator('[data-role="resume-task-lane"]')).toHaveCount(0);

  const resumePromptSeen = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.some((session: { events?: Array<{ message?: string }> }) =>
      (session.events ?? []).some((event) => event.message?.includes("responded to your intervention request and resumed this lane")),
    );
  });
  expect(resumePromptSeen).toBe(true);
});

test("task detail can re-lane an approval-paused task into a specific worker lane and auto-dispatch it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-relane",
          slug: "relane-flow",
          name: "Relane Flow",
          description: "Move approval-paused work into a different worker lane.",
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
              needsWorkTargetLaneId: null,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
            {
              id: "lane-review-pass",
              key: "review-pass",
              name: "Review pass",
              description: null,
              order: 1,
              assignedEntityType: "agent",
              assignedEntityId: "reviewer",
              entryPromptTemplate: "Take over this task and finish the redirected work.",
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
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

  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Approval relane task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-relane");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Approval relane task");
    if (!target?.activeLaneAssignment) {
      throw new Error("Expected active lane assignment for approval relane task");
    }
    const updatedAt = new Date().toISOString();
    target.status = "in_review";
    target.assigneeType = "user";
    target.assigneeId = null;
    target.activeLaneAssignment = {
      ...target.activeLaneAssignment,
      status: "awaiting_user_approval",
      pendingOutcome: "success",
      completionNotes: "Needs a dedicated review pass.",
      updatedAt,
    };
    target.updatedAt = updatedAt;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: { taskIds: [target.id], reason: "test.seed.awaiting-approval" },
    }));
  });

  const readHeaderActionLayout = async (selector: string) => page.locator(selector).evaluate((node) => {
    const relane = node.querySelector('[data-role="toggle-task-relane"]');
    const session = document.querySelector('[data-role="task-detail-primary-header"] [data-role="task-open-session"]');
    const actionMenu = node.querySelector('.task-action-menu');
    if (!(relane instanceof HTMLElement)) {
      throw new Error('Expected Re-lane button in the header action row');
    }
    if (!(actionMenu instanceof HTMLElement)) {
      throw new Error('Expected the task action menu in the header action row');
    }
    const relaneRect = relane.getBoundingClientRect();
    const actionMenuRect = actionMenu.getBoundingClientRect();
    const sessionRect = session instanceof HTMLElement ? session.getBoundingClientRect() : null;
    return {
      relaneLeftOfAction: relaneRect.left < actionMenuRect.left,
      relaneSharesRowWithAction: Math.abs(relaneRect.top - actionMenuRect.top) < 8,
      relaneLeftOfSession: sessionRect ? relaneRect.left < sessionRect.left : true,
    };
  });

  await expect(page.getByText('Task detail', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();

  const widePrimaryHeaderLayout = await readHeaderActionLayout('[data-role="task-detail-primary-actions"]');
  expect(widePrimaryHeaderLayout.relaneLeftOfAction).toBe(true);
  expect(widePrimaryHeaderLayout.relaneSharesRowWithAction).toBe(true);
  expect(widePrimaryHeaderLayout.relaneLeftOfSession).toBe(true);

  await page.setViewportSize({ width: 820, height: 900 });
  const primaryHeader = page.locator('[data-role="task-detail-primary-header"]');
  const primaryMobileActions = page.locator('[data-role="task-detail-primary-actions-mobile"]');
  await expect(primaryMobileActions.getByRole('button', { name: 'Actions' })).toBeVisible();
  await expect(primaryHeader.locator('[data-role="task-open-session"]:visible')).toHaveCount(0);
  await expect(primaryHeader.locator('[data-role="toggle-task-relane"]:visible')).toHaveCount(0);

  await primaryMobileActions.getByRole('button', { name: 'Actions' }).click();
  const primaryMobileRootLabels = await primaryMobileActions.locator('.task-action-menu__dropdown > button').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim()).filter(Boolean),
  );
  expect(primaryMobileRootLabels).toEqual(['Approve', 'Needs work', 'Move to …', 'Stop', 'Whip', 'Open session']);
  await expect(primaryMobileActions.locator('.task-detail-mobile-action-menu__divider')).toHaveCount(3);
  await expect(primaryMobileActions.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]')).toHaveCount(0);
  await primaryMobileActions.getByRole('button', { name: 'Move to …' }).click();
  await expect(primaryMobileActions.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]')).toBeVisible();
  await primaryMobileActions.locator('[data-role="task-relane-mobile-back"]').click();

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content && content.scrollHeight > content.clientHeight) {
      content.scrollTop = 1200;
      content.dispatchEvent(new Event('scroll'));
      return;
    }
    window.scrollTo({ top: 1200, behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('[data-role="task-detail-compact-header"]')).toHaveAttribute('data-scroll-state', 'hidden');
  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content && content.scrollHeight > content.clientHeight) {
      content.scrollTop = Math.max(content.scrollTop - 80, 0);
      content.dispatchEvent(new Event('scroll'));
      return;
    }
    window.scrollTo({ top: Math.max(window.scrollY - 80, 0), behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('[data-role="task-detail-compact-header"]')).toHaveAttribute('data-scroll-state', 'visible');
  await expect(page.locator('[data-role="task-detail-compact-header"]')).toBeVisible();

  const compactHeader = page.locator('[data-role="task-detail-compact-header"]');
  const compactMobileActions = page.locator('[data-role="task-detail-compact-actions-mobile"]');
  await expect(compactMobileActions.getByRole('button', { name: 'Actions' })).toBeVisible();
  await expect(compactHeader.locator('[data-role="toggle-task-relane"]:visible')).toHaveCount(0);
  await expect(compactHeader.locator('[data-role="task-open-session"]')).toHaveCount(0);

  await compactMobileActions.getByRole('button', { name: 'Actions' }).click();
  const compactMobileRootLabels = await compactMobileActions.locator('.task-action-menu__dropdown > button').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim()).filter(Boolean),
  );
  expect(compactMobileRootLabels).toEqual(['Approve', 'Needs work', 'Move to …', 'Stop', 'Whip', 'Open session']);
  await expect(compactMobileActions.locator('.task-detail-mobile-action-menu__divider')).toHaveCount(3);
  await expect(compactMobileActions.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]')).toHaveCount(0);
  await compactMobileActions.getByRole('button', { name: 'Move to …' }).click();
  await expect(compactMobileActions.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]')).toBeVisible();
  await compactMobileActions.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]').click();
  await expect(page.locator('[data-role="task-relane-confirm-dialog"]')).toBeVisible();
  await page.locator('[data-role="task-relane-notes"]').fill("Redirect this into the review pass lane.");
  await page.locator('[data-role="task-relane-confirm"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("lane-review-pass");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("active");
  await expect(page.locator('[data-role="approve-task-lane"]')).toHaveCount(0);

  const relanedTask = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((entry: { title?: string }) => entry.title === "Approval relane task");
  });
  expect(relanedTask.currentLaneId).toBe("lane-review-pass");
  expect(relanedTask.status).toBe("in_progress");
  expect(relanedTask.activeLaneAssignment?.laneId).toBe("lane-review-pass");
  expect(relanedTask.laneRuns?.[0]?.result).toBe("failure");
  expect(relanedTask.activeLaneAssignment?.sessionId).toBeTruthy();
  expect(relanedTask.comments).toHaveLength(1);
  expect(relanedTask.comments?.[0]?.author).toBe("Orchestra");
  expect(relanedTask.comments?.[0]?.originType).toBe("system");
  expect(relanedTask.comments?.[0]?.message).toBe("Re-lane note for move to Review pass (lane-review-pass):\n\nRedirect this into the review pass lane.");

  await openTaskDetailSection(page, "comments");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Orchestra");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Redirect this into the review pass lane.");
  await openTaskDetailSection(page, "timeline");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Orchestra commented");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Redirect this into the review pass lane.");

  await page.setViewportSize({ width: 1180, height: 900 });
  const wideHeaderRelane = page.locator('[data-role="task-detail-primary-header"] [data-role="toggle-task-relane"]');
  await wideHeaderRelane.scrollIntoViewIfNeeded();
  await wideHeaderRelane.click();
  await page.locator('[data-role="task-relane-option"][data-lane-id="lane-agent-approval"]').click();
  await expect(page.locator('[data-role="task-relane-confirm-dialog"]')).toBeVisible();
  await page.locator('[data-role="task-relane-notes"]').fill("   ");
  await page.locator('[data-role="task-relane-confirm"]').click();

  const relanedWithoutNoteTask = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((entry: { title?: string }) => entry.title === "Approval relane task");
  });
  expect(relanedWithoutNoteTask.currentLaneId).toBe("lane-agent-approval");
  expect(relanedWithoutNoteTask.comments).toHaveLength(1);

  await openTaskDetailSection(page, "comments");
  await expect(page.locator('[data-role="task-comment-thread"]')).toHaveCount(1);

  const wideOpenSession = page.locator('[data-role="task-detail-primary-header"] [data-role="task-open-session"]');
  await wideOpenSession.scrollIntoViewIfNeeded();
  await wideOpenSession.click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toBeVisible();
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

test("task detail can close a task immediately without deleting it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-close-task",
          slug: "close-task",
          name: "Close Task Flow",
          description: "User-owned lane for close coverage.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-user-close",
              key: "user-close",
              name: "User close",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: null,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
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
          id: "task-close-me",
          projectId: "orchestra",
          number: "ORC-88",
          title: "Close me",
          description: "Close button coverage.",
          type: "task",
          status: "in_review",
          priority: "P2",
          workflowId: "workflow-close-task",
          currentLaneId: "lane-user-close",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
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
  laneSummaries: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Close me" }).first().click();
  await expect(page.getByRole("heading", { name: "Close me" })).toBeVisible();
  await page.locator('[data-role="close-task"]').click();
  await expect(page.locator('[data-role="task-close-confirm"]')).toBeVisible();
  await page.locator('[data-role="task-close-reason"]').fill("Work is no longer needed.");
  await page.locator('[data-role="confirm-close-task"]').click();

  await expect(page.locator('[data-role="close-task"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-filter-done"]').click();
  await page.locator('[data-role="task-view-table"]').click();
  await expect(page.locator('[data-role="task-table"]')).toContainText("Close me");

  const storedTasks = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]"));
  const closedTask = storedTasks.find((task: { id: string; status?: string; comments?: Array<{ message?: string }> }) => task.id === "task-close-me");
  expect(closedTask?.status).toBe("canceled");
  expect(closedTask?.comments?.some((comment) => comment.message === "Task canceled: Work is no longer needed.")).toBe(true);
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

  await expect(page.locator('[data-role="draft-task-section"]')).toHaveCount(0);
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
  laneSummaries: [],
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

test("task detail hides and reveals the bottom tab dock based on scroll direction", async ({ page }) => {
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
    const timestamp = new Date().toISOString();
    target.description = Array.from({ length: 80 }, (_, index) => `Long task detail line ${index + 1}`).join("\n\n");
    target.updatedAt = timestamp;
    target.comments = Array.from({ length: 8 }, (_, index) => ({
      id: `comment-${index}`,
      taskId: target.id,
      author: "User",
      message: `Comment ${index + 1}`,
      interruptAgent: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    target.commentCount = target.comments.length;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "task.updated",
      },
    }));
  });

  const tabDock = page.locator('[data-role="task-detail-tab-dock"]');
  const tabList = page.getByRole("tablist", { name: "Task detail panels" });
  const compactHeader = page.locator('[data-role="task-detail-compact-header"]');
  await expect(tabDock).toBeVisible();
  await expect(tabList).toBeVisible();
  await expect(page.locator('[data-role="task-detail-section-select-mobile"]')).toBeHidden();
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="task-detail-tab-dock"] button')).map((button) => (button.firstElementChild?.textContent ?? button.textContent ?? '').trim()))).toEqual([
    'Details',
    'Comments',
    'Runtime',
    'Hierarchy',
    'Dependencies',
    'Repo files',
    'Todos',
    'Attachments',
    'Timeline',
    'Lane history',
  ]);

  const initialDockGap = await tabList.evaluate((node) => Math.round(window.innerHeight - node.getBoundingClientRect().bottom));
  expect(initialDockGap).toBeLessThanOrEqual(32);

  await scrollTaskDetailTo(page, 1400);
  await page.waitForFunction(() => {
    const content = document.querySelector(".content") as HTMLElement | null;
    return Boolean((content && content.scrollTop > 500) || window.scrollY > 500);
  });

  await expect(compactHeader).toHaveAttribute("data-scroll-state", "hidden");
  await expect(tabDock).toBeHidden();

  await scrollTaskDetailTo(page, 1332);
  await expect(compactHeader).toHaveAttribute("data-scroll-state", "visible");
  await expect(tabDock).toBeVisible();
  await expect(tabList).toBeVisible();

  await tabList.getByRole("button", { name: "Comments" }).click();
  await expect(page.locator('[data-role="task-detail-tab-comments"]')).toHaveClass(/task-detail-tab--active/);
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toContainText('Comment 8');

  await scrollTaskDetailTo(page, 0);
  await page.waitForFunction(() => {
    const content = document.querySelector(".content") as HTMLElement | null;
    return Boolean((content && content.scrollTop < 220) || window.scrollY < 220);
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Implement task foundation shell");
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toContainText('Comment 8');
});

test("task detail compact header follows scroll direction without jitter", async ({ page }) => {
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
    target.description = Array.from({ length: 90 }, (_, index) => `Scroll-direction detail line ${index + 1}`).join("\n\n");
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "task.updated",
      },
    }));
  });

  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    const documentElement = document.documentElement;
    return Boolean(
      (content && content.scrollHeight > content.clientHeight + 500)
      || documentElement.scrollHeight > window.innerHeight + 500,
    );
  });

  const compactHeader = page.locator('[data-role="task-detail-compact-header"]');
  const tabDock = page.locator('[data-role="task-detail-tab-dock"]');
  await scrollTaskDetailTo(page, 1400);
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'hidden');
  await expect(tabDock).toBeHidden();

  await scrollTaskDetailTo(page, 1332);
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'visible');
  await expect(compactHeader).toBeVisible();
  await expect(tabDock).toBeVisible();

  await scrollTaskDetailTo(page, 1337);
  await scrollTaskDetailTo(page, 1332);
  await scrollTaskDetailTo(page, 1336);
  await scrollTaskDetailTo(page, 1333);
  await page.waitForTimeout(220);
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'visible');
  await expect(compactHeader).toBeVisible();

  await scrollTaskDetailTo(page, 1372);
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'hidden');
  await expect(compactHeader).toBeHidden();
  await expect(tabDock).toBeHidden();
});

test("task detail header metadata stays in sync across the primary and compact headers", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  const headerStates = await page.evaluate(() => {
    const taskKey = "orchestra.mock.tasks";
    const workflowKey = "orchestra.mock.workflows";
    const roleKey = "orchestra.mock.roles";
    const tasks = JSON.parse(window.localStorage.getItem(taskKey) ?? "[]");
    const workflows = JSON.parse(window.localStorage.getItem(workflowKey) ?? "[]");
    const roles = JSON.parse(window.localStorage.getItem(roleKey) ?? "[]");
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected seeded task was not found");
    }
    const workflow = workflows.find((entry: { id?: string; lanes?: Array<{ id: string; name: string }> }) => entry.id === target.workflowId);
    if (!workflow || !Array.isArray(workflow.lanes) || workflow.lanes.length < 2) {
      throw new Error("Expected a seeded workflow with at least two lanes");
    }
    const seniorDeveloper = roles.find((entry: { slug?: string }) => entry.slug === "senior-developer");
    const qa = roles.find((entry: { slug?: string }) => entry.slug === "qa");
    const [initialLane, updatedLane] = workflow.lanes;
    const updatedAt = new Date().toISOString();
    target.description = Array.from({ length: 90 }, (_, index) => `Header metadata line ${index + 1}`).join("\n\n");
    target.assigneeType = "role";
    target.assigneeId = "senior-developer";
    target.currentLaneId = initialLane.id;
    target.status = "in_progress";
    target.activeLaneAssignment = target.activeLaneAssignment
      ? { ...target.activeLaneAssignment, laneId: initialLane.id, updatedAt }
      : null;
    target.updatedAt = updatedAt;
    window.localStorage.setItem(taskKey, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "test.header-metadata.initial",
      },
    }));
    return {
      taskId: target.id,
      initial: {
        assignee: seniorDeveloper?.name ?? "senior-developer",
        lane: initialLane.name,
        status: "in progress",
      },
      updated: {
        assignee: qa?.name ?? "qa",
        lane: updatedLane.name,
        status: "blocked",
      },
    };
  });

  const primaryHeader = page.locator('[data-role="task-detail-primary-header"]');
  await expect(primaryHeader.locator('[data-role="task-detail-header-assignee"]')).toHaveText(headerStates.initial.assignee);
  await expect(primaryHeader.locator('[data-role="task-detail-header-lane"]')).toHaveText(headerStates.initial.lane);
  await expect(primaryHeader.locator('[data-role="task-detail-header-status"]')).toHaveText(headerStates.initial.status);

  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    const documentElement = document.documentElement;
    return Boolean(
      (content && content.scrollHeight > content.clientHeight + 500)
      || documentElement.scrollHeight > window.innerHeight + 500,
    );
  });

  await scrollTaskDetailTo(page, 1400);
  const compactHeader = page.locator('[data-role="task-detail-compact-header"]');
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'hidden');
  await scrollTaskDetailTo(page, 1332);
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'visible');
  await expect(compactHeader).toBeVisible();
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-assignee"]')).toHaveText(headerStates.initial.assignee);
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-lane"]')).toHaveText(headerStates.initial.lane);
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-status"]')).toHaveText(headerStates.initial.status);

  await page.evaluate(({ taskId }) => {
    const taskKey = "orchestra.mock.tasks";
    const workflowKey = "orchestra.mock.workflows";
    const tasks = JSON.parse(window.localStorage.getItem(taskKey) ?? "[]");
    const workflows = JSON.parse(window.localStorage.getItem(workflowKey) ?? "[]");
    const target = tasks.find((entry: { id?: string }) => entry.id === taskId);
    if (!target) {
      throw new Error("Expected task detail target to exist");
    }
    const workflow = workflows.find((entry: { id?: string; lanes?: Array<{ id: string }> }) => entry.id === target.workflowId);
    if (!workflow || !Array.isArray(workflow.lanes) || workflow.lanes.length < 2) {
      throw new Error("Expected updated workflow lanes to exist");
    }
    const updatedAt = new Date().toISOString();
    target.assigneeType = "role";
    target.assigneeId = "qa";
    target.currentLaneId = workflow.lanes[1].id;
    target.status = "blocked";
    target.activeLaneAssignment = target.activeLaneAssignment
      ? { ...target.activeLaneAssignment, laneId: workflow.lanes[1].id, updatedAt }
      : null;
    target.updatedAt = updatedAt;
    window.localStorage.setItem(taskKey, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "test.header-metadata.updated",
      },
    }));
  }, { taskId: headerStates.taskId });

  await expect(primaryHeader.locator('[data-role="task-detail-header-assignee"]')).toHaveText(headerStates.updated.assignee);
  await expect(primaryHeader.locator('[data-role="task-detail-header-lane"]')).toHaveText(headerStates.updated.lane);
  await expect(primaryHeader.locator('[data-role="task-detail-header-status"]')).toHaveText(headerStates.updated.status);
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-assignee"]')).toHaveText(headerStates.updated.assignee);
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-lane"]')).toHaveText(headerStates.updated.lane);
  await expect(compactHeader.locator('[data-role="task-detail-compact-header-status"]')).toHaveText(headerStates.updated.status);
});

test("task detail on mobile uses a section select for tab panels", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openTasksOverviewOnMobile(page);
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.evaluate(() => {
    const key = 'orchestra.mock.tasks';
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === 'Implement task foundation shell');
    if (!target) {
      throw new Error('Expected seeded task was not found');
    }
    target.description = Array.from({ length: 60 }, (_, index) => `Mobile detail section line ${index + 1}`).join('\n\n');
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent('orchestra:task-change', {
      detail: {
        taskIds: [target.id],
        reason: 'task.updated',
      },
    }));
  });

  await expect(page.locator('[data-role="task-detail-panel"]')).toBeVisible();
  const mobileSectionSelect = page.locator('[data-role="task-detail-section-select-control"]');
  await expect(page.locator('[data-role="task-detail-section-select-mobile"]')).toBeVisible();
  expect(await mobileSectionSelect.evaluate((select) => Array.from((select as HTMLSelectElement).options).map((option) => ({ value: option.value, label: option.textContent?.trim() ?? '' })))).toEqual([
    { value: 'details', label: 'Details' },
    { value: 'comments', label: 'Comments' },
    { value: 'runtime', label: 'Runtime' },
    { value: 'hierarchy', label: 'Hierarchy' },
    { value: 'dependencies', label: 'Dependencies' },
    { value: 'repo-files', label: 'Repo files' },
    { value: 'todos', label: 'Todos' },
    { value: 'attachments', label: 'Attachments' },
    { value: 'timeline', label: 'Timeline' },
    { value: 'history', label: 'Lane history' },
  ]);
  await expect(mobileSectionSelect).toHaveValue("details");
  await expect(page.getByRole("tablist", { name: "Task detail panels" })).toBeHidden();
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toContainText('Task conversation');

  await mobileSectionSelect.selectOption("comments");
  await expect(mobileSectionSelect).toHaveValue("comments");
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toBeVisible();

  await mobileSectionSelect.selectOption("todos");
  await expect(mobileSectionSelect).toHaveValue("todos");
  await expect(page.locator('[data-role="task-detail-tabpanel-todos"]')).toBeVisible();

  await revealTaskDetailDock(page);
  await mobileSectionSelect.selectOption("details");
  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    return Boolean((content && content.scrollTop < 220) || window.scrollY < 220);
  });
  await expect(mobileSectionSelect).toHaveValue("details");
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText('Implement task foundation shell');
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toBeVisible();
});

test("task detail hides the mobile section dock on scroll down and restores it on scroll up", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openTasksOverviewOnMobile(page);
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected seeded task was not found");
    }
    target.description = Array.from({ length: 80 }, (_, index) => `Mobile dock detail line ${index + 1}`).join("\n\n");
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "task.updated",
      },
    }));
  });

  await page.waitForFunction(() => {
    const content = document.querySelector(".content") as HTMLElement | null;
    const documentElement = document.documentElement;
    return Boolean(
      (content && content.scrollHeight > content.clientHeight + 500)
      || documentElement.scrollHeight > window.innerHeight + 500,
    );
  });

  const tabDock = page.locator('[data-role="task-detail-tab-dock"]');
  const mobileSectionSelect = page.locator('[data-role="task-detail-section-select-control"]');
  await expect(tabDock).toBeVisible();
  await expect(page.locator('[data-role="task-detail-section-select-mobile"]')).toBeVisible();

  await scrollTaskDetailTo(page, 1400);
  await expect(tabDock).toBeHidden();

  const hiddenDockTop = await tabDock.evaluate((node) => Math.round(node.getBoundingClientRect().top));
  expect(hiddenDockTop).toBeGreaterThanOrEqual(828);

  await scrollTaskDetailTo(page, 1332);
  await expect(tabDock).toBeVisible();

  await mobileSectionSelect.selectOption("comments");
  await expect(mobileSectionSelect).toHaveValue("comments");
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toBeVisible();
});

test("task detail on mobile keeps the outer content scroller contained across long repo-file and comment content", async ({ page }) => {
  await seedMobileTaskDetailOverflowFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openTasksOverviewOnMobile(page);
  await page.locator('[data-role="task-card"]').filter({ hasText: "Mobile task detail overflow regression fixture" }).first().click();

  await expect(page.locator('[data-role="task-detail-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="default-file-code-viewer"]')).toBeVisible();

  let metrics = await readMobileTaskDetailOverflowMetrics(page);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);

  const mobileSectionSelect = page.locator('[data-role="task-detail-section-select-control"]');
  await mobileSectionSelect.selectOption("comments");
  await expect(mobileSectionSelect).toHaveValue("comments");
  await expect(page.locator('[data-role="task-detail-summary-comments"]')).toBeVisible();

  metrics = await readMobileTaskDetailOverflowMetrics(page);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);

  await mobileSectionSelect.selectOption("repo-files");
  await expect(mobileSectionSelect).toHaveValue("repo-files");
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();

  metrics = await readMobileTaskDetailOverflowMetrics(page);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
});

test("task detail edit mode exposes bottom-right Save and Cancel FABs on mobile", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openTasksOverviewOnMobile(page);
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();
  await expect(page.locator('[data-role="task-detail-panel"]')).toBeVisible();

  await page.getByRole("button", { name: "Overview actions" }).click();
  await page.getByRole("button", { name: "Edit Task" }).click();

  const editFab = page.locator('[data-role="task-detail-edit-fab"]');
  const cancelButton = page.locator('[data-role="cancel-task-edit"]');
  const saveButton = page.locator('[data-role="save-task"]');
  await expect(editFab).toBeVisible();
  await expect(cancelButton).toBeVisible();
  await expect(saveButton).toBeVisible();
  await expect(saveButton).toHaveText("Save");

  const geometry = await page.evaluate(() => {
    const fab = document.querySelector('[data-role="task-detail-edit-fab"]') as HTMLElement | null;
    const dock = document.querySelector('[data-role="task-detail-tab-dock"]') as HTMLElement | null;
    if (!fab || !dock) {
      throw new Error("Expected edit FAB and tab dock to be rendered");
    }
    const fabRect = fab.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    return {
      fabRightGap: Math.round(window.innerWidth - fabRect.right),
      fabBottom: Math.round(fabRect.bottom),
      dockTop: Math.round(dockRect.top),
    };
  });
  expect(geometry.fabRightGap).toBeLessThanOrEqual(24);
  expect(geometry.fabBottom).toBeLessThanOrEqual(geometry.dockTop - 8);

  await page.locator('[data-role="task-title"]').fill("Unsaved mobile edit title");
  await cancelButton.click();

  await expect(editFab).toHaveCount(0);
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Implement task foundation shell");
  await expect(page.locator('[data-role="task-title-heading"]')).not.toContainText("Unsaved mobile edit title");
});

test("task detail compact header stays below the mobile topbar while scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openTasksOverviewOnMobile(page);
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected seeded task was not found");
    }
    target.description = Array.from({ length: 80 }, (_, index) => `Mobile compact header line ${index + 1}`).join("\n\n");
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: {
        taskIds: [target.id],
        reason: "task.updated",
      },
    }));
  });

  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    return Boolean(content && content.scrollHeight > content.clientHeight + 500);
  });

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content && content.scrollHeight > content.clientHeight) {
      content.scrollTop = 1400;
      content.dispatchEvent(new Event('scroll'));
      return;
    }
    window.scrollTo({ top: 1400, behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });

  const compactHeader = page.locator('[data-role="task-detail-compact-header"]');
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'hidden');
  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content && content.scrollHeight > content.clientHeight) {
      content.scrollTop = 1320;
      content.dispatchEvent(new Event('scroll'));
      return;
    }
    window.scrollTo({ top: 1320, behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(compactHeader).toHaveAttribute('data-scroll-state', 'visible');
  await expect(compactHeader).toBeVisible();
  await page.waitForFunction(() => {
    const topbar = document.querySelector('[data-role="mobile-topbar"]') as HTMLElement | null;
    const compact = document.querySelector('[data-role="task-detail-compact-header"]') as HTMLElement | null;
    if (!topbar || !compact) {
      return false;
    }
    return compact.getBoundingClientRect().top >= topbar.getBoundingClientRect().bottom + 8;
  });
  const headerGeometry = await page.evaluate(() => {
    const topbar = document.querySelector('[data-role="mobile-topbar"]') as HTMLElement | null;
    const compact = document.querySelector('[data-role="task-detail-compact-header"]') as HTMLElement | null;
    if (!topbar || !compact) {
      throw new Error("Expected mobile topbar and compact task header to be rendered");
    }
    const topbarRect = topbar.getBoundingClientRect();
    const compactRect = compact.getBoundingClientRect();
    return {
      topbarBottom: Math.round(topbarRect.bottom),
      compactTop: Math.round(compactRect.top),
    };
  });
  expect(headerGeometry.compactTop).toBeGreaterThanOrEqual(headerGeometry.topbarBottom + 8);
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

test("task detail on mobile swaps the brand for back and actions while hiding the create fab", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await page.getByRole("button", { name: "Tasks" }).click();

  await page.locator('[data-role="task-card"]').first().click();

  await expect(page.locator('[data-role="task-detail-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="mobile-topbar-brand"]')).toHaveCount(0);
  await expect(page.locator('[data-role="mobile-subpage-back"]')).toBeVisible();
  await expect(page.locator('[data-role="mobile-topbar-actions"]')).toBeVisible();
  await expect(page.locator('[data-role="tasks-create-fab"]')).toHaveCount(0);

  await page.locator('[data-role="mobile-topbar-actions"]').getByRole('button', { name: 'Task actions' }).click();
  await expect(page.locator('.task-action-menu__dropdown')).toBeVisible();

  await page.locator('[data-role="mobile-subpage-back"]').click();
  await expect(page.locator('[data-role="task-detail-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-role="new-task"]')).toHaveCount(0);
  await expect(page.locator('[data-role="mobile-supervisor-chat-fab"]')).toBeVisible();
  await expect(page.locator('[data-role="mobile-topbar-brand"]')).toBeVisible();
});
