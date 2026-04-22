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

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Draft board task");
  await expect(page.locator('[data-role="publish-task"]')).toBeVisible();
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

  const overviewTags = page.locator('[data-role="task-overview-tags"] [data-role="task-tag-chip"]');
  await expect(overviewTags).toHaveCount(3);
  await expect(overviewTags.nth(0)).toContainText("api");
  await expect(overviewTags.nth(1)).toContainText("backend");
  await expect(overviewTags.nth(2)).toContainText("frontend");

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

  await expect(page.locator('[data-role="task-overview-tags"] [data-role="task-tag-chip"]').nth(0)).toContainText("api");
  await expect(page.locator('[data-role="task-overview-tags"] [data-role="task-tag-chip"]').nth(1)).toContainText("backend");
  await expect(page.locator('[data-role="task-overview-tags"] [data-role="task-tag-chip"]').nth(2)).toContainText("ops");
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
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: "2026-04-21T13:00:00.000Z",
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

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
  await expect(secondPage.locator('[data-role="task-sort-field"]')).toHaveValue("tags");
  await expect(secondPage.locator('[data-role="task-sort-direction"]')).toHaveValue("asc");
  await secondPage.close();
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

test("task detail opens tracked repo files when clicking $file mentions in comments", async ({ page }) => {
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
  await page.locator('[data-role="task-comment-message"]').fill("Please review $docs/design.md before you continue.");
  await page.locator('[data-role="add-task-comment"]').click();

  await page.locator('[data-role="task-comment-mention-link"]').first().click();
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

  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Mention source task");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-detail-tab-comments"]').click();
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

test("task comments show newest threads first", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Comment ordering task");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("First comment");
  await page.locator('[data-role="add-task-comment"]').click();

  await page.waitForTimeout(25);
  await page.locator('[data-role="task-comment-message"]').fill("Second comment");
  await page.locator('[data-role="add-task-comment"]').click();

  const comments = page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-item"]');
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

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  const detailedComment = page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"]').first();
  await expect(detailedComment).toContainText("First review line");
  await expect(detailedComment).toContainText("Second review line with important context");
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"] strong')).toContainText("important");
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"] li')).toHaveCount(2);
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"] ol li').nth(1)).toHaveAttribute("value", "2");
  const commentHtml = await detailedComment.evaluate((node) => node.innerHTML);
  expect(commentHtml).toContain("<br");
  expect(commentHtml).toContain("<ol");
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
  await page.locator('[data-role="task-comment-message"]').press("Control+Enter");

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");

  await page.locator('[data-role="task-detail-tab-repo-files"]').click();
  await page.locator('[data-role="reply-task-comment-summary"]').first().click();
  await expect(page.locator('[data-role="task-detail-tab-comments"]')).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-role="task-reply-author"]').fill("Worker");
  await page.locator('[data-role="task-reply-message"]').fill("I checked the task context and updated the plan.");
  await page.locator('[data-role="task-reply-message"]').press("Control+Enter");

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

test("task comment unread badges track non-user comments and clear when the comments tab is opened", async ({ page }) => {
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
          id: "task-comment-unread",
          projectId: "orchestra",
          number: "ORC-7",
          title: "Unread task comments",
          description: "Unread comment badge coverage.",
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
              id: "comment-agent",
              taskId: "task-comment-unread",
              author: "Reviewer",
              originType: "agent",
              originId: "agent-reviewer",
              message: "Please update the implementation plan.",
              interruptAgent: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: "comment-user",
              taskId: "task-comment-unread",
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
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.task-comment-user-receipts", JSON.stringify([]));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="nav-badge-tasks"]')).toContainText("1");
  await expect(
    page.locator('[data-role="task-card"]').filter({ hasText: "Unread task comments" }).first().locator('[data-role="task-card-unread-comments-badge"]'),
  ).toContainText("1 unread");
  await page.locator('[data-role="task-view-table"]').click();
  await expect(
    page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread task comments" }).locator('[data-role="task-table-unread-comments-badge"]'),
  ).toContainText("1 unread");
  await page.locator('[data-role="task-table-row"]').filter({ hasText: "Unread task comments" }).first().click();
  await expect(page.locator('[data-role="task-unread-comments-footer-badge"]')).toContainText("1 unread");
  await page.locator('[data-role="open-task-comments"]').click();
  await expect(page.locator('[data-role="task-detail-tab-comments"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-role="task-unread-comments-footer-badge"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-unread-comments-tab-badge"]')).toHaveCount(0);
  await expect(page.locator('[data-role="nav-badge-tasks"]')).toHaveCount(0);
});

test("task detail only shows session navigation when the task has an active session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
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
          laneRuns: [],
          activeLaneAssignment: {
            id: "assignment-session-linked",
            taskId: "task-session-linked",
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            status: "active",
            sessionId: "session-task-linked",
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
          id: "task-session-missing",
          projectId: "orchestra",
          number: "ORC-202",
          title: "Task without active session",
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
  await expect(page.locator('[data-role="task-open-session"]')).toBeVisible();
  await page.locator('[data-role="task-open-session"]').click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-task-linked");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Active task session");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail?.("task-session-missing");
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Task without active session");
  await expect(page.locator('[data-role="task-open-session"]')).toHaveCount(0);
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

  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await page.locator('[data-role="toggle-task-relane"]').first().click();
  await expect(page.locator('[data-role="task-relane-menu"]').first()).toBeVisible();
  await page.locator('[data-role="task-relane-option"][data-lane-id="lane-review-pass"]').first().click();
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

test("task detail keeps the bottom tab dock visible while scrolling", async ({ page }) => {
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

  const tabDock = page.getByRole('tablist', { name: 'Task detail panels' });
  await expect(tabDock).toBeVisible();

  const initialDockGap = await tabDock.evaluate((node) => Math.round(window.innerHeight - node.getBoundingClientRect().bottom));
  expect(initialDockGap).toBeLessThanOrEqual(32);

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
  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    return Boolean((content && content.scrollTop > 500) || window.scrollY > 500);
  });

  await expect(page.locator('.task-detail-floating-header')).toBeVisible();
  await tabDock.getByRole('button', { name: 'Task details' }).click();
  await page.waitForFunction(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    return Boolean((content && content.scrollTop < 220) || window.scrollY < 220);
  });
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText('Implement task foundation shell');

  await tabDock.getByRole('tab', { name: 'Comments' }).click();
  await expect(page.locator('[data-role="task-detail-tab-comments"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"]')).toBeVisible();

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
