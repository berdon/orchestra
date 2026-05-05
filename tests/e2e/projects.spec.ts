import { expect, test } from "@playwright/test";

import { PLAYWRIGHT_WEB_URL } from "./webServerConfig";

function fulfillJson(route: any, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function expectProjectSectionLoaded(page: { locator: (selector: string) => any }, sectionId: "automation" | "source-control" | "secrets", panelSelector: string, readySelector: string) {
  await page.locator('[data-role="project-detail-section-select-control"]').selectOption(sectionId);
  await expect(page.locator(panelSelector)).toBeVisible();
  await expect(page.locator(readySelector)).toBeVisible();
  await expect(page.locator(panelSelector)).not.toContainText("Loading");
}

function createHostedWebSecretsApiMock() {
  const now = () => new Date().toISOString();
  const project = {
    id: "project-secret-1",
    slug: "secret-project",
    name: "Secret Project",
    description: "Hosted-web project secret CRUD coverage.",
    taskPrefix: "SEC",
    defaultRepositoryId: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const repositories: Array<Record<string, unknown>> = [];
  let secretCounter = 1;
  const secrets: Array<Record<string, string | null>> = [];
  const requestCounts = {
    taskAutomation: 0,
    sourceControlGlobal: 0,
    sourceControlProject: 0,
    secrets: 0,
  };

  const bootstrap = {
    contractVersion: "2026-05-02",
    bootstrappedAt: "2026-04-23T00:00:00.000Z",
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
      sessionStreaming: true,
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
        commentDelete: { availability: "available" },
        commentDeleteImpact: { availability: "available" },
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
        stream: { availability: "available" },
        runtimeControls: { availability: "available" },
        modelSelection: { availability: "available" },
      },
      host: {
        logsWindow: { availability: "unavailable", reason: "Desktop only" },
        agentTerminal: { availability: "unavailable", reason: "Desktop only" },
        systemNotifications: { availability: "unavailable", reason: "Desktop only" },
        bridgeDiagnostics: { availability: "unavailable", reason: "Desktop only" },
        runtimeLogs: { availability: "unavailable", reason: "Desktop only" },
        harnessSettings: { availability: "available" },
        remoteAccess: { availability: "unavailable", reason: "Desktop only" },
      },
    },
    appInfo: {
      appName: "Orchestra",
      environment: "test",
      backendStatus: "ready",
      versionDisplay: "0.1.0",
      dispatchBlocked: false,
      dispatchBlockedReason: null,
      piRuntimeDiagnostics: {
        runtime: {
          available: true,
          source: "bundled",
          packagedMode: false,
          resolvedPath: null,
          error: null,
          message: "ready",
        },
        auth: {
          configured: true,
          agentDir: "/tmp/agent",
          authPath: "/tmp/auth.json",
          modelsPath: "/tmp/models.json",
          settingsPath: "/tmp/settings.json",
          authExists: true,
          modelsExists: true,
          legacyAgentDir: null,
          legacyAuthAvailable: false,
          legacyModelsAvailable: false,
          authImportedAt: null,
          modelsImportedAt: null,
          message: "ready",
        },
        addOns: {
          packagedMode: false,
          allowed: true,
          extraExtensions: [],
          blockedExtensions: [],
          message: "ready",
        },
      },
    },
  };

  function currentSecretsState() {
    return {
      projectSlug: project.slug,
      availability: { status: "available", message: null },
      secrets: secrets.map(({ value, ...secret }) => secret),
    };
  }

  return {
    secrets,
    requestCounts,
    async handle(route: any) {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const pathname = url.pathname;

      if (pathname === "/api/v1/frontend/bootstrap") {
        return fulfillJson(route, bootstrap);
      }
      if (pathname === "/api/v1/projects" && method === "GET") {
        return fulfillJson(route, [project]);
      }
      if (pathname === `/api/v1/projects/${project.id}` && method === "GET") {
        return fulfillJson(route, { ...project, repositories });
      }
      if (pathname === "/api/v1/project-settings/task-automation" && method === "GET") {
        requestCounts.taskAutomation += 1;
        return fulfillJson(route, {
          projectSlug: project.slug,
          autoDispatchOnBlockerCompletion: true,
          updatedAt: "2026-05-01T00:00:00.000Z",
        });
      }
      if (pathname === "/api/v1/settings/source-control" && method === "GET") {
        requestCounts.sourceControlGlobal += 1;
        return fulfillJson(route, {
          gitUserNameTemplate: null,
          gitEmailTemplate: null,
          updatedAt: "2026-05-01T00:00:00.000Z",
        });
      }
      if (pathname === "/api/v1/project-settings/source-control" && method === "GET") {
        requestCounts.sourceControlProject += 1;
        return fulfillJson(route, {
          projectSlug: project.slug,
          gitUserNameTemplate: null,
          gitEmailTemplate: null,
          updatedAt: "2026-05-01T00:00:00.000Z",
        });
      }
      if (pathname === "/api/v1/project-settings/secrets" && method === "GET") {
        requestCounts.secrets += 1;
        return fulfillJson(route, currentSecretsState());
      }
      if (pathname === "/api/v1/project-settings/secrets" && method === "POST") {
        const body = request.postDataJSON() as { secretKey: string; description?: string | null; value?: string | null };
        const timestamp = now();
        secrets.push({
          id: `secret-${secretCounter++}`,
          projectId: project.id,
          projectSlug: project.slug,
          secretKey: body.secretKey,
          description: body.description ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastRotatedAt: timestamp,
          valueState: "ready",
          valueStateMessage: null,
          value: body.value ?? null,
        });
        return fulfillJson(route, currentSecretsState());
      }
      const secretMatch = pathname.match(/^\/api\/v1\/project-settings\/secrets\/([^/]+)$/);
      if (secretMatch && method === "PATCH") {
        const secretKey = decodeURIComponent(secretMatch[1] ?? "");
        const body = request.postDataJSON() as { description?: string | null; value?: string | null };
        const secret = secrets.find((entry) => entry.secretKey === secretKey);
        if (!secret) {
          return fulfillJson(route, { error: "Not found" }, 404);
        }
        secret.description = body.description ?? null;
        secret.updatedAt = now();
        if (body.value) {
          secret.value = body.value;
          secret.lastRotatedAt = secret.updatedAt;
        }
        return fulfillJson(route, currentSecretsState());
      }
      if (secretMatch && method === "DELETE") {
        const secretKey = decodeURIComponent(secretMatch[1] ?? "");
        const index = secrets.findIndex((entry) => entry.secretKey === secretKey);
        if (index >= 0) {
          secrets.splice(index, 1);
        }
        return fulfillJson(route, currentSecretsState());
      }
      if (pathname === "/api/v1/agents" || pathname === "/api/v1/roles" || pathname === "/api/v1/workflows") {
        return fulfillJson(route, []);
      }
      return fulfillJson(route, []);
    },
  };
}

test("settings projects panel creates a project and repository", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByText("Built-in projects are editable like any other project.")).toHaveCount(0);
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Client Work");
  await page.locator('[data-role="project-task-prefix"]').fill("CLI");
  await page.locator('[data-role="project-description"]').fill("A separate customer-facing project.");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("Client repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/client-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Client repo");

  const storedState = await page.evaluate(() => {
    const projects = JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]");
    return projects.find((project: { name: string }) => project.name === "Client Work") ?? null;
  });

  expect(storedState?.taskPrefix).toBe("CLI");
  expect(storedState?.repositories?.length).toBe(1);
  expect(storedState?.repositories?.[0]?.name).toBe("Client repo");
});

test("project settings detail hides the floating tab dock on scroll down and still shows the browser unsupported secrets state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.locator('[data-role="project-detail-tab-general"][aria-selected="true"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-repositories"]')).toBeVisible();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Secret Project");
  await page.locator('[data-role="project-task-prefix"]').fill("SEC");
  await page.getByRole("button", { name: /Create project/i }).click();

  await expect(page.locator('[data-role="project-detail-tab-dock"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-general"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-repositories"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-automation"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-source-control"]')).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-secrets"]')).toBeVisible();

  const dockLayout = await page.evaluate(() => {
    const dock = document.querySelector('[data-role="project-detail-tab-dock"]') as HTMLElement | null;
    if (!dock) {
      throw new Error("Expected project detail tab dock to be rendered");
    }
    const rect = dock.getBoundingClientRect();
    return {
      position: window.getComputedStyle(dock).position,
      bottomGap: Math.round(window.innerHeight - rect.bottom),
    };
  });
  expect(dockLayout.position).toBe("fixed");
  expect(dockLayout.bottomGap).toBeLessThanOrEqual(32);
  await expect(page.locator('[data-role="project-detail-tab-dock"]')).toHaveAttribute('data-scroll-state', 'visible');

  await page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('[data-role="project-detail-tab-dock"]')).toHaveAttribute('data-scroll-state', 'hidden');
  await page.evaluate(() => {
    window.scrollTo({ top: 120, behavior: 'auto' });
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('[data-role="project-detail-tab-dock"]')).toHaveAttribute('data-scroll-state', 'visible');

  await page.locator('[data-role="project-detail-tab-repositories"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-repositories"]')).toBeVisible();

  await page.locator('[data-role="project-detail-tab-source-control"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-source-control"]')).toBeVisible();

  await page.locator('[data-role="project-detail-tab-secrets"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-secrets"]')).toBeVisible();
  await expect(page.locator('[data-role="project-secrets-status"]')).toContainText("Unsupported");
  await expect(page.locator('[data-role="project-secrets-status"]')).toContainText("unavailable in the browser/mock host");
  await expect(page.locator('[data-role="save-project-secret"]')).toBeDisabled();
});

test("project settings asynchronously prefetches tab-specific hosted-web settings data after the general panel renders", async ({ page }) => {
  const api = createHostedWebSecretsApiMock();
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.__ORCHESTRA_HOST_MODE__ = "hosted_web";
    window.confirm = () => true;
  });
  await page.route("**/api/v1/**", (route) => api.handle(route));

  await page.goto("/?page=settings&settingsTab=projects");
  await expect(page.locator('[data-role="project-detail-tabpanel-general"]')).toBeVisible();

  expect(api.requestCounts.taskAutomation).toBe(0);
  expect(api.requestCounts.sourceControlGlobal).toBe(0);
  expect(api.requestCounts.sourceControlProject).toBe(0);
  expect(api.requestCounts.secrets).toBe(0);

  await expect.poll(() => api.requestCounts.taskAutomation).toBe(1);
  await expect.poll(() => api.requestCounts.sourceControlGlobal).toBe(1);
  await expect.poll(() => api.requestCounts.sourceControlProject).toBe(1);
  await expect.poll(() => api.requestCounts.secrets).toBe(1);

  await page.locator('[data-role="project-detail-tab-automation"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-automation"]')).toBeVisible();
  expect(api.requestCounts.taskAutomation).toBe(1);

  await page.locator('[data-role="project-detail-tab-source-control"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-source-control"]')).toBeVisible();
  expect(api.requestCounts.sourceControlGlobal).toBe(1);
  expect(api.requestCounts.sourceControlProject).toBe(1);

  await page.locator('[data-role="project-detail-tab-secrets"]').click();
  await expect(page.locator('[data-role="project-detail-tabpanel-secrets"]')).toBeVisible();
  expect(api.requestCounts.secrets).toBe(1);
});

test("project settings hides the floating tab dock on mobile scroll down and restores it on scroll up", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?page=settings&settingsTab=projects");

  const mobileSubnav = page.locator('[data-role="project-mobile-subnav-shell"]');
  const floatingSubnav = page.locator('[data-role="project-mobile-subnav-floating-shell"]');
  const mobileSubnavSelect = page.locator('[data-role="project-mobile-subnav-select-control"]');
  const dock = page.locator('[data-role="project-detail-tab-dock"]');
  const sectionSelect = page.locator('[data-role="project-detail-section-select-mobile"]');
  const sectionSelectControl = page.locator('[data-role="project-detail-section-select-control"]');
  await expect(mobileSubnav).toBeVisible();
  await expect(mobileSubnavSelect).toBeVisible();
  await expect(page.locator('.settings-mobile-subnav-panel')).toBeHidden();
  await expect(page.locator('[data-role="project-mobile-subnav-menu-trigger"]')).toBeVisible();
  await expect(floatingSubnav).toHaveAttribute('data-scroll-state', 'hidden');
  await expect(sectionSelect).toBeVisible();
  await expect(page.locator('[data-role="project-detail-tab-general"]')).toBeHidden();

  await expectProjectSectionLoaded(
    page,
    'automation',
    '[data-role="project-detail-tabpanel-automation"]',
    '[data-role="project-auto-dispatch-on-blocker-completion"]',
  );
  await expectProjectSectionLoaded(
    page,
    'source-control',
    '[data-role="project-detail-tabpanel-source-control"]',
    '[data-role="project-source-control-settings"]',
  );
  await expectProjectSectionLoaded(
    page,
    'secrets',
    '[data-role="project-detail-tabpanel-secrets"]',
    '[data-role="project-secrets-status"]',
  );

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 500;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await expect(floatingSubnav).toHaveAttribute('data-scroll-state', 'hidden');
  await expect(dock).toHaveAttribute('data-scroll-state', 'hidden');
  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 420;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await expect(floatingSubnav).toHaveAttribute('data-scroll-state', 'visible');
  await expect(dock).toHaveAttribute('data-scroll-state', 'visible');
  await page.waitForFunction(() => {
    const topbar = document.querySelector('[data-role="mobile-topbar"]') as HTMLElement | null;
    const floating = document.querySelector('[data-role="project-mobile-subnav-floating-shell"]') as HTMLElement | null;
    if (!topbar || !floating) {
      return false;
    }
    return floating.getBoundingClientRect().top >= topbar.getBoundingClientRect().bottom + 8;
  });

  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute('data-scroll-state', 'visible');
  await expect(sectionSelect).toBeVisible();
  await expect(sectionSelectControl).toHaveValue('secrets');
  await expect(page.locator('[data-role="project-detail-tab-general"]')).toBeHidden();

  const dockLayout = await page.evaluate(() => {
    const dockElement = document.querySelector('[data-role="project-detail-tab-dock"]') as HTMLElement | null;
    if (!dockElement) {
      throw new Error("Expected project detail tab dock to be rendered");
    }
    const rect = dockElement.getBoundingClientRect();
    return {
      position: window.getComputedStyle(dockElement).position,
      bottomGap: Math.round(window.innerHeight - rect.bottom),
      rightGap: Math.round(window.innerWidth - rect.right),
    };
  });
  expect(dockLayout.position).toBe("fixed");
  expect(dockLayout.bottomGap).toBeLessThanOrEqual(32);
  expect(dockLayout.rightGap).toBeGreaterThanOrEqual(0);
});

test("project settings secrets tab supports hosted-web CRUD and rotation flows without revealing values", async ({ page }) => {
  const api = createHostedWebSecretsApiMock();
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.__ORCHESTRA_HOST_MODE__ = "hosted_web";
    window.confirm = () => true;
  });
  await page.route("**/api/v1/**", (route) => api.handle(route));

  await page.goto("/?page=settings&settingsTab=projects");
  await page.locator('[data-role="project-detail-tab-secrets"]').click();

  await expect(page.locator('[data-role="project-secrets-status"]')).toContainText("Available");
  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("No project secrets yet.");

  await page.locator('[data-role="project-secret-key"]').fill("OPENAI_API_KEY");
  await page.locator('[data-role="project-secret-description"]').fill("Primary provider key");
  await page.locator('[data-role="project-secret-value"]').fill("sk-live-1");
  await page.locator('[data-role="save-project-secret"]').click();

  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("OPENAI_API_KEY");
  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("Primary provider key");
  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("Ready");
  await expect(page.locator('[data-role="project-secret-key"]')).toHaveValue("");
  await expect(page.locator('[data-role="project-secret-value"]')).toHaveValue("");
  await expect(page.getByText("sk-live-1", { exact: true })).toHaveCount(0);
  expect(api.secrets[0]?.value).toBe("sk-live-1");

  await page.getByRole("button", { name: "Edit / rotate" }).click();
  await expect(page.locator('[data-role="project-secret-key"]')).toBeDisabled();
  await expect(page.locator('[data-role="project-secret-description"]')).toHaveValue("Primary provider key");
  await expect(page.locator('[data-role="project-secret-value"]')).toHaveValue("");

  await page.locator('[data-role="project-secret-description"]').fill("Rotated provider key");
  await page.locator('[data-role="project-secret-value"]').fill("sk-live-2");
  await page.locator('[data-role="save-project-secret"]').click();

  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("Rotated provider key");
  await expect(page.getByText("sk-live-2", { exact: true })).toHaveCount(0);
  expect(api.secrets[0]?.value).toBe("sk-live-2");

  await page.getByRole("button", { name: "Delete secret" }).click();
  await expect(page.locator('[data-role="project-secrets-list"]')).toContainText("No project secrets yet.");
  expect(api.secrets).toEqual([]);
});

test("new tasks use the configured project task prefix in browser mode", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Web Platform");
  await page.locator('[data-role="project-task-prefix"]').fill("WEB2");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Ship landing page");
  await page.locator('[data-role="save-task"]').click();

  const storedTask = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Ship landing page") ?? null;
  });

  expect(storedTask?.number).toBe("WEB2-1");
});

test("settings projects panel deletes a repository and falls back the project default cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.confirm = () => true;
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Repository Cleanup Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("First repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/first-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await page.locator('[data-role="repository-name"]').fill("Second repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/second-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await expect(page.locator('[data-role="project-repositories"]')).toContainText("First repo");
  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Second repo");

  const secondRepoCard = page.locator('[data-role="project-repositories"] .task-history-card').filter({ hasText: "Second repo" });
  await secondRepoCard.getByRole("button", { name: "Make default" }).click();
  await secondRepoCard.getByRole("button", { name: "Delete repository" }).click();
  await expect(page.locator('[data-role="project-repositories"]')).not.toContainText("Second repo");

  const storedState = await page.evaluate(() => {
    const projects = JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]");
    return projects.find((project: { name: string }) => project.name === "Repository Cleanup Project") ?? null;
  });

  expect(storedState?.repositories?.length).toBe(1);
  expect(storedState?.repositories?.[0]?.name).toBe("First repo");
  expect(storedState?.defaultRepositoryId).toBe(storedState?.repositories?.[0]?.id ?? null);
});

test("settings projects panel deletes a non-default project and falls back cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Disposable Project");
  await page.getByRole("button", { name: /Create project/i }).click();
  await expect(page.getByRole("heading", { name: "Disposable Project" })).toBeVisible();

  await page.locator('[data-role="delete-project"]').click();
  await expect(page.locator('[data-role="delete-project"]')).toHaveText("Confirm delete");
  await page.locator('[data-role="delete-project"]').click();
  await expect(page.getByRole("heading", { name: "Orchestra" })).toBeVisible();
  await expect(page.locator('nav[aria-label="Projects"]')).not.toContainText("Disposable Project");

  const storedState = await page.evaluate(() => ({
    activeProjectId: window.localStorage.getItem("orchestra.preferences.active-project-id") ?? window.localStorage.getItem("orchestra.mock.active-project-id"),
    projects: JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]"),
  }));

  expect(storedState.activeProjectId).toBe("orchestra");
  expect(storedState.projects.some((project: { name: string }) => project.name === "Disposable Project")).toBe(false);
});

test("settings projects panel deletes the seeded default project cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Orchestra" })).toBeVisible();
  await page.locator('[data-role="delete-project"]').click();
  await expect(page.locator('[data-role="delete-project"]')).toHaveText("Confirm delete");
  await page.locator('[data-role="delete-project"]').click();

  await expect(page.locator('nav[aria-label="Projects"]')).not.toContainText("Orchestra");

  const storedState = await page.evaluate(() => ({
    activeProjectId: window.localStorage.getItem("orchestra.preferences.active-project-id") ?? window.localStorage.getItem("orchestra.mock.active-project-id"),
    projects: JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]"),
  }));

  expect(storedState.activeProjectId).toBeNull();
  expect(storedState.projects).toEqual([]);
});

test("deleting the seeded default project does not resurrect or write browser-mode task state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Orchestra" })).toBeVisible();
  await page.locator('[data-role="delete-project"]').click();
  await expect(page.locator('[data-role="delete-project"]')).toHaveText("Confirm delete");
  await page.locator('[data-role="delete-project"]').click();

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Should not be created without a project");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.locator('[data-role="tasks-status-error"]')).toContainText("Something went wrong.");
  await expect(page.locator('[data-role="tasks-status-error"]')).toContainText("Create a project before creating a task.");

  const storedState = await page.evaluate(() => ({
    activeProjectId: window.localStorage.getItem("orchestra.preferences.active-project-id") ?? window.localStorage.getItem("orchestra.mock.active-project-id"),
    projects: JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]"),
    tasks: JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]"),
  }));

  expect(storedState.activeProjectId).toBeNull();
  expect(storedState.projects).toEqual([]);
  expect(storedState.tasks).toEqual([]);
});

test("project switcher isolates browser-mode task state by project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Second Project");
  await page.getByRole("button", { name: /Create project/i }).click();
  await expect(page.locator('[data-role="project-switcher"]')).toHaveValue(/project-/);
  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project one task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Second Project" });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toHaveCount(0);

  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project two task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project two task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project two task");
});
