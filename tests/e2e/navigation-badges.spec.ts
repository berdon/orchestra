import { expect, test } from "@playwright/test";

test("navigation badges reflect unread inbox work and active sessions per project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();

    window.localStorage.setItem("orchestra.mock.active-project-id", "orchestra");
    window.localStorage.setItem(
      "orchestra.mock.projects",
      JSON.stringify([
        {
          id: "orchestra",
          slug: "orchestra",
          name: "Orchestra",
          description: "Default project",
          defaultRepositoryId: "repo-orchestra",
          createdAt: timestamp,
          updatedAt: timestamp,
          repositories: [],
        },
        {
          id: "project-alpha",
          slug: "alpha",
          name: "Alpha",
          description: null,
          defaultRepositoryId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          repositories: [],
        },
        {
          id: "project-beta",
          slug: "beta",
          name: "Beta",
          description: null,
          defaultRepositoryId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          repositories: [],
        },
      ]),
    );

    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-alpha-review",
          projectId: "project-alpha",
          number: "ALP-1",
          title: "Alpha review request",
          description: null,
          type: "task",
          status: "in_review",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
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

    window.localStorage.setItem(
      "orchestra.mock.mailbox",
      JSON.stringify([
        {
          deliveryId: "delivery-beta-1",
          messageId: "message-beta-1",
          projectId: "project-beta",
          taskId: null,
          taskNumber: null,
          taskTitle: null,
          senderType: "agent",
          senderId: "agent-beta",
          senderLabel: "Beta Agent",
          recipientType: "user",
          recipientId: "desktop-user",
          recipientLabel: "User",
          assignmentId: null,
          body: "Please respond to the beta request.",
          priority: "interrupt",
          readAt: null,
          readSessionId: null,
          archivedAt: null,
          lastNotifiedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );

    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.localStorage.setItem(
      "orchestra.mock.sessions.project-alpha",
      JSON.stringify([
        {
          id: "session-alpha-1",
          title: "Alpha session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.project-beta",
      JSON.stringify([
        {
          id: "session-beta-1",
          title: "Beta session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator('[data-role="toggle-sidebar-collapse"]').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-collapsed', 'true');

  await expect(page.locator('[data-role="project-switcher-trigger-badge"]')).toHaveAttribute('aria-label', 'Unread activity in other projects');
  await expect(page.locator('[data-role="project-switcher-trigger-badge"]')).toHaveClass(/status-badge--dot/);

  const collapsedBadgeGeometry = await page.evaluate(() => {
    const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
    const triggerBadge = document.querySelector('[data-role="project-switcher-trigger-badge"]');
    if (!(trigger instanceof HTMLElement) || !(triggerBadge instanceof HTMLElement)) {
      return null;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const triggerBadgeRect = triggerBadge.getBoundingClientRect();
    return {
      triggerBadgeWithinRail: triggerBadgeRect.right <= triggerRect.right + 1 && triggerBadgeRect.top >= triggerRect.top - 1,
      triggerBadgeWidth: Math.round(triggerBadgeRect.width),
    };
  });

  expect(collapsedBadgeGeometry).not.toBeNull();
  expect(collapsedBadgeGeometry?.triggerBadgeWithinRail).toBe(true);
  expect(collapsedBadgeGeometry?.triggerBadgeWidth ?? 999).toBeLessThanOrEqual(18);

  await page.locator('[data-role="project-switcher-trigger"]').click();
  const menu = page.locator('[data-role="project-switcher-menu"]');
  await expect(menu).toBeVisible();
  const collapsedMenuGeometry = await page.evaluate(() => {
    const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
    const panel = document.querySelector('[data-role="project-switcher-menu"]');
    if (!(trigger instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      return null;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      width: Math.round(panelRect.width),
      left: Math.round(panelRect.left),
      triggerRight: Math.round(triggerRect.right),
    };
  });
  expect(collapsedMenuGeometry).not.toBeNull();
  expect(collapsedMenuGeometry?.width ?? 0).toBeGreaterThanOrEqual(220);
  expect(collapsedMenuGeometry?.left ?? 0).toBeGreaterThanOrEqual((collapsedMenuGeometry?.triggerRight ?? 0) - 1);

  await expect(page.locator('[data-role="project-switcher-option-alpha"]')).toContainText("Alpha");
  await expect(page.locator('[data-role="project-switcher-option-alpha"]')).toContainText("1");
  await expect(page.locator('[data-role="project-switcher-option-beta"]')).toContainText("Beta");
  await expect(page.locator('[data-role="project-switcher-option-beta"]')).toContainText("1");
  await page.locator('[data-role="project-switcher-option-alpha"]').click();

  await expect(page.locator('[data-role="project-switcher-trigger-badge"]')).toHaveText("1");
  await expect(page.locator('[data-role="nav-badge-inbox"]')).toHaveText("1");
  await expect(page.locator('[data-role="nav-badge-sessions"]')).toHaveText("1");
  await expect(page.locator('[data-role="nav-badge-inbox"]')).toHaveClass(/status-badge--rail/);
  await expect(page.locator('[data-role="nav-badge-sessions"]')).toHaveClass(/status-badge--rail/);

  const activeRailBadgeGeometry = await page.evaluate(() => {
    const inboxButton = document.querySelector('[data-role="nav-item-inbox"]');
    const inboxBadge = document.querySelector('[data-role="nav-badge-inbox"]');
    const sessionsButton = document.querySelector('[data-role="nav-item-sessions"]');
    const sessionsBadge = document.querySelector('[data-role="nav-badge-sessions"]');
    if (!(inboxButton instanceof HTMLElement) || !(inboxBadge instanceof HTMLElement) || !(sessionsButton instanceof HTMLElement) || !(sessionsBadge instanceof HTMLElement)) {
      return null;
    }

    const inboxRect = inboxButton.getBoundingClientRect();
    const inboxBadgeRect = inboxBadge.getBoundingClientRect();
    const sessionsRect = sessionsButton.getBoundingClientRect();
    const sessionsBadgeRect = sessionsBadge.getBoundingClientRect();
    return {
      inboxBadgeWithinRail: inboxBadgeRect.right <= inboxRect.right + 1 && inboxBadgeRect.top >= inboxRect.top - 1,
      sessionsBadgeWithinRail: sessionsBadgeRect.right <= sessionsRect.right + 1 && sessionsBadgeRect.top >= sessionsRect.top - 1,
      inboxBadgeWidth: Math.round(inboxBadgeRect.width),
      sessionsBadgeWidth: Math.round(sessionsBadgeRect.width),
    };
  });
  expect(activeRailBadgeGeometry).not.toBeNull();
  expect(activeRailBadgeGeometry?.inboxBadgeWithinRail).toBe(true);
  expect(activeRailBadgeGeometry?.sessionsBadgeWithinRail).toBe(true);
  expect(activeRailBadgeGeometry?.inboxBadgeWidth ?? 999).toBeLessThanOrEqual(24);
  expect(activeRailBadgeGeometry?.sessionsBadgeWidth ?? 999).toBeLessThanOrEqual(24);

  await page.locator('[data-role="nav-item-sessions"]').click();
  await expect(page.locator('.session-list')).toContainText('Alpha session');
  await expect(page.locator('.session-list')).not.toContainText('Beta session');

  await page.locator('[data-role="project-switcher-trigger"]').click();
  await page.locator('[data-role="project-switcher-option-beta"]').click();
  await expect(page.locator('[data-role="project-switcher-trigger-badge"]')).toHaveText("1");
  await expect(page.locator('[data-role="nav-badge-inbox"]')).toHaveText("1");
  await expect(page.locator('[data-role="nav-badge-sessions"]')).toHaveText("1");
  await expect(page.locator('.session-list')).toContainText('Beta session');
  await expect(page.locator('.session-list')).not.toContainText('Alpha session');
});
