import { expect, test } from "@playwright/test";

function normalizeHexColor(value: string) {
  const normalized = value.trim().toLowerCase();
  const shorthand = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!shorthand) {
    return normalized;
  }
  return `#${shorthand[1]}${shorthand[1]}${shorthand[2]}${shorthand[2]}${shorthand[3]}${shorthand[3]}`;
}

const THEME_CASES = [
  {
    id: "orchestra-light",
    kind: "light",
    colorScheme: "light",
    appBackground: "#f6f8fc",
  },
  {
    id: "orchestra-dark",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#1e1e1e",
  },
  {
    id: "orchestra-high-contrast",
    kind: "high-contrast",
    colorScheme: "dark",
    appBackground: "#000000",
  },
  {
    id: "vscode-light-plus",
    kind: "light",
    colorScheme: "light",
    appBackground: "#ffffff",
  },
  {
    id: "vscode-dark-plus",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#1e1e1e",
  },
  {
    id: "one-dark-pro",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#282c34",
  },
  {
    id: "dracula",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#282a36",
  },
  {
    id: "gruvbox-light",
    kind: "light",
    colorScheme: "light",
    appBackground: "#f9f5d7",
  },
  {
    id: "gruvbox-dark",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#282828",
  },
  {
    id: "solarized-light",
    kind: "light",
    colorScheme: "light",
    appBackground: "#fdf6e3",
  },
  {
    id: "solarized-dark",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#002b36",
  },
  {
    id: "nord",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#2e3440",
  },
  {
    id: "tokyo-night",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#1a1b26",
  },
  {
    id: "catppuccin-latte",
    kind: "light",
    colorScheme: "light",
    appBackground: "#eff1f5",
  },
  {
    id: "catppuccin-mocha",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#1e1e2e",
  },
  {
    id: "monokai",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#272822",
  },
] as const;

for (const themeCase of THEME_CASES) {
  test(`applies ${themeCase.id} from stored preferences`, async ({ page }) => {
    await page.addInitScript((themeId: string) => {
      window.localStorage.clear();
      window.localStorage.setItem("orchestra.preferences.theme", themeId);
    }, themeCase.id);

    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("data-theme", themeCase.id);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", themeCase.id);

    const themeState = await page.evaluate(() => {
      const root = document.documentElement;
      const shell = document.querySelector(".app-shell") as HTMLElement | null;
      const styles = getComputedStyle(root);
      return {
        rootTheme: root.dataset.theme ?? null,
        rootThemeKind: root.dataset.themeKind ?? null,
        rootColorScheme: root.style.colorScheme,
        appBackground: styles.getPropertyValue("--color-app-background").trim(),
        shellTheme: shell?.dataset.theme ?? null,
        shellThemeKind: shell?.dataset.themeKind ?? null,
      };
    });

    expect(themeState.rootTheme).toBe(themeCase.id);
    expect(themeState.rootThemeKind).toBe(themeCase.kind);
    expect(themeState.rootColorScheme).toBe(themeCase.colorScheme);
    expect(normalizeHexColor(themeState.appBackground)).toBe(normalizeHexColor(themeCase.appBackground));
    expect(themeState.shellTheme).toBe(themeCase.id);
    expect(themeState.shellThemeKind).toBe(themeCase.kind);
  });
}

test("draft and scheduled task cards stay visible against the page background in light and dark themes", async ({ page }) => {
  for (const themeId of ["vscode-light-plus", "tokyo-night"] as const) {
    await page.addInitScript((selectedTheme: string) => {
      window.localStorage.clear();
      window.localStorage.setItem("orchestra.preferences.theme", selectedTheme);
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        "orchestra.mock.workflows",
        JSON.stringify([
          {
            id: "workflow-1",
            slug: "workflow-1",
            name: "Workflow 1",
            description: null,
            archived: false,
            createdAt: timestamp,
            updatedAt: timestamp,
            lanes: [
              {
                id: "lane-plan",
                key: "plan",
                name: "Plan",
                description: null,
                order: 0,
                assignedEntityType: "user",
                assignedEntityId: null,
                entryPromptTemplate: null,
                useSeparateWorktree: false,
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
            id: "task-draft-1",
            projectId: "orchestra",
            number: "ORC-1",
            title: "Visible draft task",
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
            id: "schedule-1",
            projectId: "orchestra",
            taskBlueprint: {
              title: "Visible scheduled task",
              description: "A scheduled definition",
              type: "task",
              status: "ready",
              priority: "P2",
              workflowId: "workflow-1",
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
            trigger: { type: "event", eventKey: "task.created" },
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
    }, themeId);

    await page.goto("/");
    await page.getByRole("button", { name: "Tasks", exact: true }).click();

    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const draftCard = document.querySelector('[data-role="task-card"]') as HTMLElement | null;
      const scheduleCard = document.querySelector('[data-role="task-schedule-card"]') as HTMLElement | null;
      return {
        appBackground: root.getPropertyValue("--color-app-background").trim(),
        draftCardBackground: draftCard ? getComputedStyle(draftCard).backgroundColor : null,
        draftCardBorder: draftCard ? getComputedStyle(draftCard).borderTopColor : null,
        scheduleCardBackground: scheduleCard ? getComputedStyle(scheduleCard).backgroundColor : null,
        scheduleCardBorder: scheduleCard ? getComputedStyle(scheduleCard).borderTopColor : null,
      };
    });

    expect(colors.draftCardBackground).not.toBeNull();
    expect(colors.scheduleCardBackground).not.toBeNull();
    expect(colors.draftCardBorder).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.scheduleCardBorder).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.draftCardBackground).not.toBe(colors.appBackground);
    expect(colors.scheduleCardBackground).not.toBe(colors.appBackground);
  }
});
