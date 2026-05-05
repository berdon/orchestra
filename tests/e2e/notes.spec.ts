import { expect, test } from "@playwright/test";

import { PLAYWRIGHT_WEB_URL } from "./webServerConfig";

function fulfillJson(route: any, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test("notes mobile preview, page scrolling, and floating header behavior stay aligned with task details", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const projectId = "project-notes-1";
  const projectSlug = "notes-fixture";
  const repositoryId = "repo-docs";
  const longBody = Array.from({ length: 80 }, (_, index) => `Section ${index + 1}\n\n- mobile note content ${index + 1}\n- preview swap coverage ${index + 1}`).join("\n\n");
  const project = {
    id: projectId,
    slug: projectSlug,
    name: "Notes Fixture",
    description: "Project fixture for Notes mobile coverage.",
    taskPrefix: "NOT",
    defaultRepositoryId: repositoryId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const repository = {
    id: repositoryId,
    projectId,
    slug: "docs-repository",
    name: "Docs Repository",
    repositoryPath: "/tmp/docs-repository",
    sourcePath: null,
    sourceKind: "local",
    mode: "existing",
    defaultBranch: "main",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const notesByKey: Record<string, string> = {
    "project::planning/roadmap.md": `# Roadmap\n\n${longBody}\n`,
    "project::planning/mobile/ux.md": "# Mobile UX\n\nFloating header behavior note.\n",
    [`repository:${repositoryId}::guides/setup.md`]: "# Setup\n\nRepository note body.\n",
  };
  const notesTree = {
    projectId,
    roots: [
      {
        scope: "project",
        repositoryId: null,
        label: "Project",
        docsExists: true,
        children: [
          {
            kind: "directory",
            name: "planning",
            path: "planning",
            children: [
              {
                kind: "directory",
                name: "mobile",
                path: "planning/mobile",
                children: [
                  { kind: "note", name: "ux.md", path: "planning/mobile/ux.md" },
                ],
              },
              { kind: "note", name: "roadmap.md", path: "planning/roadmap.md" },
            ],
          },
        ],
      },
      {
        scope: "repository",
        repositoryId,
        label: "Docs Repository",
        docsExists: true,
        children: [
          {
            kind: "directory",
            name: "guides",
            path: "guides",
            children: [
              { kind: "note", name: "setup.md", path: "guides/setup.md" },
            ],
          },
        ],
      },
    ],
  };
  const bootstrap = {
    contractVersion: "2026-05-02",
    bootstrappedAt: timestamp,
    hostKind: "remote_api",
    authMode: "same_origin_cookie",
    urls: {
      apiBaseUrl: PLAYWRIGHT_WEB_URL,
      websocketUrl: null,
    },
    featureFlags: {
      sharedCatalog: true,
      sharedTasks: true,
      sharedInbox: true,
      sharedSessions: true,
      sharedSkills: true,
      sharedNotes: true,
      taskSchedules: true,
      sessionStreaming: false,
      sessionControls: true,
      taskComments: true,
      taskFiles: true,
      desktopWindows: false,
      agentTerminal: false,
    },
    capabilities: {
      app: {
        bootstrap: { availability: "available" },
        errorReporting: { availability: "available" },
      },
      catalog: {
        projects: { availability: "available" },
        agents: { availability: "available" },
        roles: { availability: "available" },
        workflows: { availability: "available" },
      },
      admin: {
        projects: { availability: "available" },
        settings: { availability: "available" },
        workers: { availability: "available" },
        workflows: { availability: "available" },
        policies: { availability: "available" },
        channels: { availability: "available" },
        modelCatalog: { availability: "available" },
        piExecutableDiagnostic: { availability: "unavailable", reason: "Desktop only" },
      },
      skills: {
        read: { availability: "available" },
        create: { availability: "available" },
        update: { availability: "available" },
        archive: { availability: "available" },
        delete: { availability: "available" },
        assign: { availability: "available" },
      },
      notes: {
        read: { availability: "available" },
        write: { availability: "available" },
      },
      tasks: {
        read: { availability: "available" },
        write: { availability: "available" },
        review: { availability: "available" },
        comments: { availability: "available" },
        todos: { availability: "available" },
        dependencies: { availability: "available" },
        attachments: { availability: "available" },
        fileReferences: { availability: "available" },
        fileContents: { availability: "available" },
        schedules: { availability: "available" },
      },
      inbox: {
        read: { availability: "available" },
        write: { availability: "available" },
        archive: { availability: "available" },
      },
      sessions: {
        read: { availability: "available" },
        write: { availability: "available" },
        stream: { availability: "unavailable", reason: "Streaming is disabled for this browser test fixture." },
        runtimeControls: { availability: "available" },
        modelSelection: { availability: "available" },
      },
      host: {
        logsWindow: { availability: "unavailable", reason: "Desktop only" },
        agentTerminal: { availability: "unavailable", reason: "Desktop only" },
        systemNotifications: { availability: "unavailable", reason: "Desktop only" },
        bridgeDiagnostics: { availability: "unavailable", reason: "Desktop only" },
        runtimeLogs: { availability: "unavailable", reason: "Desktop only" },
        harnessSettings: { availability: "unavailable", reason: "Desktop only" },
        remoteAccess: { availability: "unavailable", reason: "Desktop only" },
      },
    },
    appInfo: null,
  };

  await page.addInitScript(({ projectId: activeProjectId, projectSlug: activeProjectSlug }) => {
    window.__ORCHESTRA_HOST_MODE__ = "hosted_web";
    window.localStorage.clear();
    window.confirm = () => true;
    window.localStorage.setItem("orchestra.preferences.active-project-id", activeProjectId);
    window.localStorage.setItem("orchestra.preferences.active-project-slug", activeProjectSlug);
  }, { projectId, projectSlug });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;

    if (pathname === "/api/v1/frontend/bootstrap") {
      return fulfillJson(route, bootstrap);
    }
    if (pathname === "/api/v1/app-info" && method === "GET") {
      return fulfillJson(route, {
        appName: "Orchestra",
        environment: "browser",
        backendStatus: "connected",
        versionDisplay: "test",
        dispatchBlocked: false,
        dispatchBlockedReason: null,
        piRuntimeDiagnostics: {
          runtime: {
            available: false,
            source: "browser-test",
            packagedMode: false,
            resolvedPath: null,
            error: null,
            message: "Unavailable in browser test.",
          },
          auth: {
            configured: false,
            agentDir: "/tmp/orchestra-test",
            authPath: "/tmp/orchestra-test/auth.json",
            modelsPath: "/tmp/orchestra-test/models.json",
            settingsPath: "/tmp/orchestra-test/settings.json",
            authExists: false,
            modelsExists: false,
            legacyAgentDir: null,
            legacyAuthAvailable: false,
            legacyModelsAvailable: false,
            authImportedAt: null,
            modelsImportedAt: null,
            message: "Unavailable in browser test.",
          },
          addOns: {
            packagedMode: false,
            allowed: true,
            extraExtensions: [],
            blockedExtensions: [],
            message: "Browser test fixture.",
          },
        },
      });
    }
    if (pathname === "/api/v1/projects" && method === "GET") {
      return fulfillJson(route, [project]);
    }
    if (pathname === `/api/v1/projects/${projectId}` && method === "GET") {
      return fulfillJson(route, { ...project, repositories: [repository] });
    }
    if (pathname === `/api/v1/projects/${projectId}/notes` && method === "GET") {
      return fulfillJson(route, notesTree);
    }
    if (pathname === `/api/v1/projects/${projectId}/notes/read` && method === "POST") {
      const body = request.postDataJSON() as { location: { scope: "project" | "repository"; repositoryId?: string | null; path: string } };
      const location = body.location;
      const key = location.scope === "project"
        ? `project::${location.path}`
        : `repository:${location.repositoryId ?? ""}::${location.path}`;
      return fulfillJson(route, {
        location,
        markdown: notesByKey[key] ?? "",
        exists: key in notesByKey,
      });
    }
    if (pathname === "/api/v1/inbox" && method === "GET") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/v1/tasks" && method === "GET") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/v1/agents" && method === "GET") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/v1/roles" && method === "GET") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/v1/workflows" && method === "GET") {
      return fulfillJson(route, []);
    }
    return fulfillJson(route, []);
  });

  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto(`/?page=notes&projectId=${projectId}`);

  const mobileSelect = page.locator('[data-role="notes-detail-header-select-control"]');
  const headerActionsTrigger = page.locator('[data-role="notes-detail-header-actions-trigger"]');
  const primaryHeader = page.locator('[data-role="notes-detail-primary-header"]');

  await expect(mobileSelect).toBeVisible();
  await expect(headerActionsTrigger).toBeVisible();
  await expect(page.locator('.notes-page__navigation')).toBeHidden();

  await mobileSelect.selectOption({ label: "Project · Note · planning/roadmap.md" });
  await expect(page.locator('[data-role="notes-markdown-editor"]')).toHaveValue(/Section 1/);

  const editMetrics = await page.evaluate(() => {
    const editor = document.querySelector('.notes-markdown-editor') as HTMLElement | null;
    const content = document.querySelector('.content') as HTMLElement | null;
    return editor && content
      ? {
          editorHeight: editor.getBoundingClientRect().height,
          contentClientHeight: content.clientHeight,
          contentScrollHeight: content.scrollHeight,
        }
      : null;
  });
  expect(editMetrics).not.toBeNull();
  expect(editMetrics?.editorHeight ?? 0).toBeGreaterThan(1000);
  expect(editMetrics?.contentScrollHeight ?? 0).toBeGreaterThan(editMetrics?.contentClientHeight ?? 0);

  await headerActionsTrigger.click();
  const actionMenu = page.locator('.task-action-menu__dropdown');
  await expect(actionMenu.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(actionMenu.getByRole("button", { name: "New note" })).toBeVisible();
  await expect(actionMenu.getByRole("button", { name: "New folder" })).toBeVisible();
  await expect(actionMenu.getByRole("button", { name: "Move / rename" })).toBeVisible();
  await expect(actionMenu.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(actionMenu.getByRole("button", { name: "Delete" })).toBeVisible();
  await page.locator('.notes-page__detail-header-copy').click();
  await expect(actionMenu).toBeHidden();

  const primaryHeaderHeightBeforeScroll = await primaryHeader.evaluate((element) => element.getBoundingClientRect().height);

  await page.getByRole("button", { name: "Show preview" }).click();
  await expect(page.locator('[data-role="notes-preview-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="notes-markdown-editor"]')).toHaveCount(0);

  const previewMetrics = await page.evaluate(() => {
    const preview = document.querySelector('[data-role="notes-preview-panel"]') as HTMLElement | null;
    return preview
      ? {
          previewHeight: preview.getBoundingClientRect().height,
          previewOverflowY: window.getComputedStyle(preview).overflowY,
        }
      : null;
  });
  expect(previewMetrics).not.toBeNull();
  expect(previewMetrics?.previewHeight ?? 0).toBeGreaterThan(1000);
  expect(previewMetrics?.previewOverflowY).not.toBe("auto");
  expect(previewMetrics?.previewOverflowY).not.toBe("scroll");

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 900;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForFunction(() => {
    const floating = document.querySelector('[data-role="notes-detail-compact-header"]');
    return Boolean(floating) && floating?.getAttribute('data-scroll-state') === 'hidden';
  });

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 720;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForFunction(() => document.querySelector('[data-role="notes-detail-compact-header"]')?.getAttribute('data-scroll-state') === 'visible');

  const primaryHeaderHeightAfterScroll = await primaryHeader.evaluate((element) => element.getBoundingClientRect().height);
  expect(primaryHeaderHeightAfterScroll).toBe(primaryHeaderHeightBeforeScroll);

  await page.getByRole("button", { name: "Edit note" }).click();
  await expect(page.locator('[data-role="notes-preview-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-role="notes-markdown-editor"]')).toBeVisible();
});
