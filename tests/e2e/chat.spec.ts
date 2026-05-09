import { expect, test } from "@playwright/test";
import {
  appendMockSessionEvent,
  buildMockSessionEvents,
  expectTranscriptAutoScrollOn,
  expectTranscriptNotAtBottom,
  scrollTranscriptUp,
} from "./session-scroll-helpers";

async function measureChatLayout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const pageScroller = document.scrollingElement as HTMLElement | null;
    const content = document.querySelector('.content') as HTMLElement | null;
    const contentBody = document.querySelector('.content__body') as HTMLDivElement | null;
    const stack = document.querySelector('.panel-stack--sessions') as HTMLElement | null;
    const detailColumn = document.querySelector('.session-detail-column') as HTMLElement | null;
    const panel = document.querySelector('[data-role="session-chat-panel"]') as HTMLElement | null;
    const transcript = document.querySelector('[data-role="session-transcript"]') as HTMLDivElement | null;
    const composerInput = document.querySelector('[data-role="composer-input"]') as HTMLTextAreaElement | null;
    const composerFooter = document.querySelector('.composer__footer') as HTMLDivElement | null;
    const sendButton = document.querySelector('[data-role="send-message"]') as HTMLButtonElement | null;
    const sendOptionsTrigger = document.querySelector('[data-role="session-send-options-trigger"]') as HTMLButtonElement | null;
    const settingsTrigger = document.querySelector('[data-role="session-actions-trigger"]') as HTMLButtonElement | null;
    const modelSelect = document.querySelector('.session-model-field--composer .select-input') as HTMLSelectElement | null;
    const panelHeader = panel?.querySelector('.panel__header') as HTMLElement | null;
    const mobileAgentPicker = document.querySelector('[data-role="chat-mobile-agent-switcher"]') as HTMLElement | null;
    const mobilePickerTrigger = document.querySelector('[data-role="chat-mobile-agent-picker-trigger"]') as HTMLElement | null;
    const mobileTranscriptControlsTrigger = document.querySelector('[data-role="session-mobile-transcript-controls-trigger"]') as HTMLElement | null;

    if (!content || !contentBody || !stack || !detailColumn || !panel || !transcript || !composerInput || !composerFooter || !sendButton || !sendOptionsTrigger || !settingsTrigger || !modelSelect) {
      return null;
    }

    const detailRect = detailColumn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const transcriptRect = transcript.getBoundingClientRect();
    const composerRect = composerInput.getBoundingClientRect();
    const composerFooterRect = composerFooter.getBoundingClientRect();
    const sendRect = sendButton.getBoundingClientRect();
    const sendOptionsRect = sendOptionsTrigger.getBoundingClientRect();
    const settingsRect = settingsTrigger.getBoundingClientRect();
    const modelRect = modelSelect.getBoundingClientRect();
    const mobilePickerTriggerRect = mobilePickerTrigger?.getBoundingClientRect() ?? null;
    const mobileTranscriptControlsTriggerRect = mobileTranscriptControlsTrigger?.getBoundingClientRect() ?? null;

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageScrollHeight: pageScroller?.scrollHeight ?? null,
      pageClientHeight: pageScroller?.clientHeight ?? null,
      pageScrollable: pageScroller ? pageScroller.scrollHeight - pageScroller.clientHeight > 1 : false,
      contentHeight: content.getBoundingClientRect().height,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      contentOverflowY: window.getComputedStyle(content).overflowY,
      contentScrollable: content.scrollHeight - content.clientHeight > 1,
      documentScrollWidth: document.documentElement.scrollWidth,
      contentBodyHeight: contentBody.getBoundingClientRect().height,
      stackHeight: stack.getBoundingClientRect().height,
      detailHeight: detailRect.height,
      detailTop: detailRect.top,
      detailClientHeight: detailColumn.clientHeight,
      detailScrollHeight: detailColumn.scrollHeight,
      detailOverflowY: window.getComputedStyle(detailColumn).overflowY,
      detailScrollable: detailColumn.scrollHeight - detailColumn.clientHeight > 1
        && ["auto", "scroll", "overlay"].includes(window.getComputedStyle(detailColumn).overflowY),
      panelHeight: panelRect.height,
      panelTop: panelRect.top,
      transcriptHeight: transcriptRect.height,
      transcriptTop: transcriptRect.top,
      transcriptClientHeight: transcript.clientHeight,
      transcriptScrollHeight: transcript.scrollHeight,
      transcriptOverflowY: window.getComputedStyle(transcript).overflowY,
      transcriptScrollable: transcript.scrollHeight - transcript.clientHeight > 1
        && ["auto", "scroll", "overlay"].includes(window.getComputedStyle(transcript).overflowY),
      composerInputHeight: composerRect.height,
      composerInputWidth: composerRect.width,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      sendTop: sendRect.top,
      sendBottom: sendRect.bottom,
      sendOptionsTop: sendOptionsRect.top,
      sendOptionsBottom: sendOptionsRect.bottom,
      settingsTop: settingsRect.top,
      settingsBottom: settingsRect.bottom,
      sendDisabled: sendButton.disabled,
      composerFooterWidth: composerFooterRect.width,
      modelTop: modelRect.top,
      modelBottom: modelRect.bottom,
      modelWidth: modelRect.width,
      panelHeaderVisible: panelHeader ? window.getComputedStyle(panelHeader).display !== 'none' : false,
      mobileAgentPickerTop: mobileAgentPicker?.getBoundingClientRect().top ?? null,
      mobilePickerRight: mobilePickerTriggerRect?.right ?? null,
      mobileTranscriptControlsLeft: mobileTranscriptControlsTriggerRect?.left ?? null,
      mobileTranscriptControlsRight: mobileTranscriptControlsTriggerRect?.right ?? null,
      panelResize: window.getComputedStyle(panel).resize,
      composerResize: window.getComputedStyle(composerInput).resize,
    };
  });
}

async function dragComposerResizeCorner(page: import("@playwright/test").Page) {
  const composerInput = page.locator('[data-role="composer-input"]');
  const box = await composerInput.boundingBox();
  if (!box) {
    throw new Error("Expected composer input bounds");
  }

  const x = box.x + box.width - 3;
  const y = box.y + box.height - 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 120, { steps: 15 });
  await page.mouse.up();
}

async function appendMockChatSessionEvents(page: import("@playwright/test").Page, sessionId: string, count = 80) {
  await page.evaluate(({ nextSessionId, nextCount }) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const baseTime = Date.now();
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== nextSessionId) {
        return session;
      }
      const extraEvents = Array.from({ length: nextCount }, (_, index) => ({
        id: `chat-layout-event-${index}`,
        kind: index % 2 === 0 ? "user" : "assistant",
        message: `Chat layout event ${index}\n${"transcript ".repeat(40)}`,
        timestamp: new Date(baseTime + index * 1000).toISOString(),
      }));
      return {
        ...session,
        events: [...session.events, ...extraEvents],
        updatedAt: new Date(baseTime + nextCount * 1000).toISOString(),
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: [nextSessionId],
        reason: "test.chat_layout_resize",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, { nextSessionId: sessionId, nextCount: count });
}

async function measureTranscriptHorizontalOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const transcript = document.querySelector('[data-role="session-transcript"]') as HTMLDivElement | null;
    const panel = document.querySelector('[data-role="session-chat-panel"]') as HTMLElement | null;

    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      panelClientWidth: panel?.clientWidth ?? 0,
      panelScrollWidth: panel?.scrollWidth ?? 0,
      transcriptClientWidth: transcript?.clientWidth ?? 0,
      transcriptScrollWidth: transcript?.scrollWidth ?? 0,
    };
  });
}

async function readSessionLogCount(page: import("@playwright/test").Page, target: string) {
  return page.evaluate((nextTarget) => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]") as Array<{ target?: string }>;
    return logs.filter((entry) => entry.target === nextTarget).length;
  }, target);
}

test("chat nav lists named agents and excludes roles", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await expect(page.locator('[data-role="project-switcher"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Reviewer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "Reviewer" })).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator('[data-role="chat-agent-nav-supervisor"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-agent-nav-data"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: "Reviewer" })).toHaveCount(0);
});

test("chat nav refreshes project-scoped agents in place and keeps archived agents hidden", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Client Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Client Project" });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator('[data-role="chat-agent-nav-supervisor"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-agent-nav-data"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-agent-nav-client-builder"]')).toHaveCount(0);

  await page.evaluate(() => {
    const projects = JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]") as Array<{ id: string; name: string }>;
    const agents = JSON.parse(window.localStorage.getItem("orchestra.mock.agents") ?? "[]") as Array<Record<string, unknown>>;
    const clientProjectId = projects.find((project) => project.name === "Client Project")?.id ?? null;
    const template = agents.find((agent) => agent.slug === "data") ?? agents[0];
    if (!clientProjectId || !template) {
      throw new Error("Unable to prepare project-scoped chat agent test data.");
    }

    const now = new Date().toISOString();
    const nextAgent = {
      ...template,
      id: "agent-client-builder",
      name: "Client Builder",
      slug: "client-builder",
      description: "Project-scoped builder for chat nav refresh coverage.",
      archived: false,
      immutable: false,
      system: false,
      roleId: null,
      scope: "project",
      projectId: clientProjectId,
      createdAt: now,
      updatedAt: now,
    };

    window.localStorage.setItem("orchestra.mock.agents", JSON.stringify([nextAgent, ...agents]));
    window.dispatchEvent(new CustomEvent("orchestra:agent-catalog-changed", {
      detail: { agentId: nextAgent.id, projectId: clientProjectId, reason: "created" },
    }));
  });

  await expect(page.locator('[data-role="chat-agent-nav-client-builder"]')).toBeVisible();

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });
  await expect(page.locator('[data-role="chat-agent-nav-client-builder"]')).toHaveCount(0);

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Client Project" });
  await expect(page.locator('[data-role="chat-agent-nav-client-builder"]')).toBeVisible();

  await page.evaluate(() => {
    const agents = JSON.parse(window.localStorage.getItem("orchestra.mock.agents") ?? "[]") as Array<Record<string, unknown>>;
    const archivedAgents = agents.map((agent) => agent.id === "agent-client-builder"
      ? { ...agent, archived: true, updatedAt: new Date().toISOString() }
      : agent);
    window.localStorage.setItem("orchestra.mock.agents", JSON.stringify(archivedAgents));
    window.dispatchEvent(new CustomEvent("orchestra:agent-catalog-changed", {
      detail: { agentId: "agent-client-builder", projectId: archivedAgents.find((agent) => agent.id === "agent-client-builder")?.projectId ?? null, reason: "archived" },
    }));
  });

  await expect(page.locator('[data-role="chat-agent-nav-client-builder"]')).toHaveCount(0);
});

test("chat composer autocompletes project tasks, agents, and roles and renders task mentions as links", async ({ page }) => {
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
  await page.locator('[data-role="task-title"]').fill("Autocomplete navigation task");
  await page.locator('[data-role="save-task"]').click();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await page.locator('[data-role="composer-input"]').fill("Loop in @dat");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Data");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Agent · data");

  await page.locator('[data-role="composer-input"]').fill("Ask @rev");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Role · reviewer");

  await page.locator('[data-role="composer-input"]').fill("Please follow up on @auto");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Autocomplete navigation task");
  await page.locator('[data-role="composer-mention-option"]').filter({ hasText: "Autocomplete navigation task" }).click();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue(/Please follow up on @ORC-\d+\s/);

  await page.locator('[data-role="send-message"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Autocomplete navigation task", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]').getByRole("button", { name: /Autocomplete navigation task/ }).last()).toBeVisible({ timeout: 10_000 });
});

test("chat composer autocompletes canonical project tags", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="nav-item-tasks"]').click();

  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Backend tag source");
  await page.locator('[data-role="task-tags-input"]').fill("BackEnd");
  await page.locator('[data-role="task-tags-input"]').press("Enter");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="nav-item-tasks"]').click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Ops tag source");
  await page.locator('[data-role="task-tags-input"]').fill("ops");
  await page.locator('[data-role="task-tags-input"]').press("Enter");
  await page.locator('[data-role="save-task"]').click();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const composerInput = page.locator('[data-role="composer-input"]');

  await composerInput.fill("");
  await composerInput.click();
  await page.keyboard.type("#");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("#backend");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("#ops");
  await expect(page.locator('[data-role="composer-mention-option"]').first()).toContainText("#backend");

  await composerInput.fill("");
  await composerInput.click();
  await page.keyboard.type("Need #bac");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("#backend");
  await page.locator('[data-role="composer-mention-option"]').filter({ hasText: "#backend" }).click();
  await expect(composerInput).toHaveValue("Need #backend ");

  await composerInput.fill("");
  await composerInput.click();
  await page.keyboard.type("#backend");
  await expect(page.locator('[data-role="composer-mention-list"]')).toHaveCount(0);

  await composerInput.fill("");
  await composerInput.click();
  await page.keyboard.type("#zzz");
  await expect(page.locator('[data-role="composer-mention-list"]')).toHaveCount(0);
});

test("chat page opens an agent main session with focused chat controls while Sessions stays available", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator('.page-header')).toHaveCount(0);
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-supervisor-quick-chat"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/agent chat/i);

  await page.keyboard.press("Control+o");
  await page.locator('[data-role="command-palette-input"]').fill("chat");
  await expect(page.locator('[data-role="command-palette-results"]')).toContainText("Go to Chat");
  await expect(page.locator('[data-role="command-palette-results"]')).not.toContainText(/agent chat/i);
  await page.keyboard.press("Escape");

  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('.field-group__label').filter({ hasText: /^Send$/ })).toHaveCount(0);
  await expect(page.locator('[data-role="send-message"]')).not.toContainText("Send");
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Session model" })).toBeVisible();
  await expect(page.locator('[data-role="session-wrap-toggle"]')).toBeVisible();
  await expect(page.locator('[data-role="session-scroll-lock-toggle"]')).toBeVisible();
  await expect(page.locator('[data-role="session-context-stats"]')).toBeVisible();
  await expect(page.locator('[data-role="session-context-percent"]')).toContainText("context");

  const firstSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(firstSessionId).toBeTruthy();

  const longLine = `CHAT-${"y".repeat(600)}`;
  await page.locator('[data-role="composer-input"]').fill(longLine);
  await page.locator('[data-role="send-message"]').click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-wrap-toggle"]');
  const firstMessage = transcript.locator(".transcript-event p").last();

  await expect(firstMessage).toContainText(longLine);
  await expect(toggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre-wrap");

  await toggle.click();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre");

  await page.evaluate((sessionId) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== sessionId) {
        return session;
      }
      return {
        ...session,
        events: [],
        updatedAt: new Date().toISOString(),
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: [sessionId],
        reason: "test.chat_summary_refresh",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, firstSessionId);

  await page.waitForTimeout(400);
  await expect(transcript).toContainText(longLine);

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect.poll(async () => page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id")).toBe(firstSessionId);
});

test("chat session Open task lives in the header menu and opens the linked task detail", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const sessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  if (!sessionId) {
    throw new Error("Expected chat session id");
  }

  await page.evaluate((activeSessionId) => {
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-chat-linked",
          projectId: "orchestra",
          number: "ORC-401",
          title: "Chat linked task detail",
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
            id: "assignment-chat-linked",
            taskId: "task-chat-linked",
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            status: "active",
            sessionId: activeSessionId,
            runtimeCwd: "/tmp/orchestra/task-chat-linked",
            roleQueueEntryId: null,
            roleInstanceId: null,
            prompt: "Implement the chat-linked task.",
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

    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: Record<string, unknown>) => {
      if (session.id !== activeSessionId) {
        return session;
      }
      return {
        ...session,
        updatedAt: timestamp,
        taskId: "task-chat-linked",
        taskProjectId: "orchestra",
        taskNumber: "ORC-401",
        taskTitle: "Chat linked task detail",
        activeTaskId: "task-chat-linked",
        activeTaskProjectId: "orchestra",
        activeTaskNumber: "ORC-401",
        activeTaskTitle: "Chat linked task detail",
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: [activeSessionId],
        reason: "test.chat_open_task_header_menu",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, sessionId);

  await expect(page.locator('[data-role="session-header-actions-trigger"]')).toBeVisible();
  await page.locator('[data-role="session-actions-trigger"]').click();
  await expect(page.locator('[data-role="session-actions-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="session-actions-menu"]')).not.toContainText("Open task");
  await page.locator('[data-role="session-header-actions-trigger"]').click();
  await expect(page.locator('[data-role="session-header-actions-menu"]')).toBeVisible();
  await page.locator('[data-role="session-header-action-open-task"]').click();
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Chat linked task detail");
});

test("chat transcript keeps long wrapped messages constrained to the panel", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const longLine = `CHAT-${"y".repeat(600)}`;
  await page.locator('[data-role="composer-input"]').fill(longLine);
  await page.locator('[data-role="send-message"]').click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-wrap-toggle"]');
  const firstMessage = transcript.locator(".transcript-event p").last();

  await expect(firstMessage).toContainText(longLine);
  await expect(toggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre-wrap");

  const wrappedMetrics = await measureTranscriptHorizontalOverflow(page);
  expect(wrappedMetrics.documentScrollWidth).toBeLessThanOrEqual(wrappedMetrics.viewportWidth + 4);
  expect(wrappedMetrics.panelScrollWidth).toBeLessThanOrEqual(wrappedMetrics.panelClientWidth + 4);
  expect(wrappedMetrics.transcriptScrollWidth).toBeLessThanOrEqual(wrappedMetrics.transcriptClientWidth + 4);

  await toggle.click();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre");

  const nowrapMetrics = await measureTranscriptHorizontalOverflow(page);
  expect(nowrapMetrics.documentScrollWidth).toBeLessThanOrEqual(nowrapMetrics.viewportWidth + 4);
  expect(nowrapMetrics.panelScrollWidth).toBeLessThanOrEqual(nowrapMetrics.panelClientWidth + 4);
  expect(nowrapMetrics.transcriptScrollWidth).toBeGreaterThan(nowrapMetrics.transcriptClientWidth + 20);
});

test("chat page hides shared header controls on mobile while keeping chat usable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();

  await expect(page.locator('.page-header')).toHaveCount(0);
  await expect(page.locator('[data-role="app-version-label"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-supervisor-quick-chat"]')).toHaveCount(0);

  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toBeVisible();
  await page.locator('[data-role="chat-agent-nav-data"]').click();
  await expect(page.locator('[data-role="chat-mobile-agent-picker-trigger"]')).toContainText("Data");
  await expect(page.locator('[data-role="session-chat-panel"] > .panel__header')).toBeHidden();
  await expect(page.locator('.field-group__label').filter({ hasText: /^Send$/ })).toHaveCount(0);
  await expect(page.locator('[data-role="send-message"]')).not.toContainText("Send");
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();

  await page.locator('[data-role="composer-input"]').fill("Hello from mobile chat");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from mobile chat", { timeout: 10_000 });

  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="new-task"]')).toHaveCount(0);
  await expect(page.locator('[data-role="mobile-supervisor-chat-fab"]')).toBeVisible();
});

test("chat page fills the available height while keeping the composer resizable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const panel = page.locator('[data-role="session-chat-panel"]');
  const transcript = page.locator('[data-role="session-transcript"]');

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(transcript).toBeVisible();

  const initialLayout = await measureChatLayout(page);
  expect(initialLayout).not.toBeNull();
  expect(initialLayout?.pageScrollable).toBe(false);
  expect(initialLayout?.contentOverflowY).toBe("hidden");
  expect(initialLayout?.contentScrollable).toBe(false);
  expect(initialLayout?.stackHeight ?? 0).toBeGreaterThan((initialLayout?.contentBodyHeight ?? 0) - 24);
  expect(initialLayout?.detailHeight ?? 0).toBeGreaterThan((initialLayout?.stackHeight ?? 0) - 24);
  expect(initialLayout?.detailScrollable).toBe(false);
  expect(initialLayout?.panelHeight ?? 0).toBeGreaterThan((initialLayout?.detailHeight ?? 0) - 24);
  expect(initialLayout?.transcriptHeight ?? 0).toBeGreaterThan(400);
  expect(initialLayout?.transcriptOverflowY).toBe("auto");
  expect(initialLayout?.panelResize).toBe("none");
  expect(initialLayout?.composerResize).toBe("vertical");

  const sessionId = await panel.getAttribute("data-session-id");
  expect(sessionId).toBeTruthy();
  await appendMockChatSessionEvents(page, sessionId ?? "");
  await expect(transcript).toContainText("Chat layout event 79");

  const beforeResize = await measureChatLayout(page);
  expect(beforeResize).not.toBeNull();
  expect(beforeResize?.pageScrollable).toBe(false);
  expect(beforeResize?.contentScrollable).toBe(false);
  expect(beforeResize?.detailScrollable).toBe(false);
  expect(beforeResize?.transcriptScrollable).toBe(true);
  expect((beforeResize?.transcriptScrollHeight ?? 0) - (beforeResize?.transcriptClientHeight ?? 0)).toBeGreaterThan(200);

  await dragComposerResizeCorner(page);
  await page.waitForTimeout(100);

  const afterResize = await measureChatLayout(page);
  expect(afterResize).not.toBeNull();
  expect(afterResize?.pageScrollable).toBe(false);
  expect(afterResize?.contentScrollable).toBe(false);
  expect(afterResize?.detailScrollable).toBe(false);
  expect(afterResize?.transcriptScrollable).toBe(true);
  expect(afterResize?.composerInputHeight ?? 0).toBeGreaterThan((beforeResize?.composerInputHeight ?? 0) + 100);
  expect(afterResize?.transcriptHeight ?? 0).toBeLessThan((beforeResize?.transcriptHeight ?? 0) - 100);
  expect(Math.abs((afterResize?.panelHeight ?? 0) - (beforeResize?.panelHeight ?? 0))).toBeLessThan(8);
});

test("chat mobile keeps a page-local agent picker and usable transcript/composer layout", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await page.getByRole("button", { name: "Chat" }).click();

  await expect(page.locator('[data-role="chat-mobile-agent-picker-trigger"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-mobile-agent-picker-trigger"]')).toContainText("Supervisor");
  await expect(page.locator('[data-role="chat-agent-sidebar-nav"]')).toBeHidden();
  await expect.poll(async () => page.locator('[data-role="session-chat-panel"]').getAttribute('data-session-id')).toBeTruthy();

  const baselineSubscribeCount = await readSessionLogCount(page, "sessions.subscribe");

  await page.locator('[data-role="chat-mobile-agent-picker-trigger"]').click();
  await expect(page.locator('[data-role="chat-mobile-agent-picker"]')).toBeVisible();
  await page.locator('[data-role="chat-mobile-agent-option-data"]').click();

  await expect.poll(async () => (await readSessionLogCount(page, "sessions.subscribe")) > baselineSubscribeCount).toBe(true);
  const afterDataSubscribeCount = await readSessionLogCount(page, "sessions.subscribe");
  await expect(page.locator('[data-role="chat-mobile-agent-picker-trigger"]')).toContainText("Data");
  await expect(page.locator('[data-role="session-mobile-transcript-controls-trigger"]')).toBeVisible();
  await expect(page.locator('[data-role="session-chat-panel"] > .panel__header')).toBeHidden();
  await expect(page.locator('[data-role="composer-resize-handle"]')).toHaveCount(0);
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();
  await expect(page.locator('[data-role="session-send-summary"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-send-options-trigger"]')).toBeVisible();
  await page.locator('[data-role="session-send-options-trigger"]').click();
  await expect(page.locator('[data-role="session-send-options-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="session-send-options-menu"]')).toContainText("Queue");
  await expect(page.locator('[data-role="session-send-options-menu"]')).toContainText("Interrupt");
  await page.locator('[data-role="session-send-mode-queue"]').click();

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await expect(page.locator('[data-role="session-mobile-transcript-controls-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="session-mobile-wrap-toggle"]')).toHaveAttribute("data-wrap-mode", "wrap");
  await page.locator('[data-role="session-mobile-wrap-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(page.locator('[data-role="session-mobile-transcript-controls-menu"]')).toHaveCount(0);

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await expect(page.locator('[data-role="session-mobile-auto-scroll-toggle"]')).toHaveAttribute("data-auto-scroll-mode", "on");
  await page.locator('[data-role="session-mobile-auto-scroll-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-scroll-locked", "false");

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await page.locator('[data-role="session-mobile-auto-scroll-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-scroll-locked", "true");

  await page.locator('[data-role="composer-input"]').fill("Mobile chat message");
  await page.locator('[data-role="send-message"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Mobile chat message", { timeout: 10_000 });

  const mobileLayout = await measureChatLayout(page);
  expect(mobileLayout).not.toBeNull();
  expect(mobileLayout?.panelTop ?? 999).toBeLessThan(340);
  expect(mobileLayout?.mobileAgentPickerTop ?? 999).toBeLessThan(mobileLayout?.panelTop ?? 999);
  expect(mobileLayout?.documentScrollWidth ?? 999).toBeLessThanOrEqual(mobileLayout?.viewportWidth ?? 0);
  expect((mobileLayout?.mobileTranscriptControlsLeft ?? 0) - (mobileLayout?.mobilePickerRight ?? 0)).toBeGreaterThanOrEqual(0);
  expect((mobileLayout?.mobileTranscriptControlsLeft ?? 999) - (mobileLayout?.mobilePickerRight ?? 0)).toBeLessThanOrEqual(12);
  expect(mobileLayout?.mobileTranscriptControlsRight ?? 999).toBeLessThanOrEqual(mobileLayout?.viewportWidth ?? 0);
  expect(mobileLayout?.panelHeaderVisible).toBe(false);
  expect(mobileLayout?.transcriptHeight ?? 0).toBeGreaterThan(160);
  expect(mobileLayout?.transcriptTop ?? 999).toBeLessThan((mobileLayout?.viewportHeight ?? 0) - 180);
  expect(mobileLayout?.composerBottom ?? 999).toBeLessThanOrEqual((mobileLayout?.viewportHeight ?? 0) - 8);
  expect(mobileLayout?.sendBottom ?? 999).toBeLessThanOrEqual((mobileLayout?.viewportHeight ?? 0) - 8);
  expect(mobileLayout?.sendDisabled).toBe(false);
  const mobileActionTops = [mobileLayout?.settingsTop ?? 0, mobileLayout?.modelTop ?? 0, mobileLayout?.sendTop ?? 0, mobileLayout?.sendOptionsTop ?? 0];
  expect(Math.max(...mobileActionTops) - Math.min(...mobileActionTops)).toBeLessThanOrEqual(2);
  expect(Math.abs((mobileLayout?.composerFooterWidth ?? 0) - (mobileLayout?.composerInputWidth ?? 0))).toBeLessThanOrEqual(2);
  expect(mobileLayout?.modelWidth ?? 999).toBeLessThan((mobileLayout?.composerInputWidth ?? 0) * 0.6);

  await page.locator('[data-role="chat-mobile-agent-picker-trigger"]').click();
  const mobilePickerSurface = await page.locator('[data-role="chat-mobile-agent-picker"]').evaluate((element) => {
    const styles = window.getComputedStyle(element as HTMLElement);
    return {
      backgroundColor: styles.backgroundColor,
      borderTopWidth: styles.borderTopWidth,
    };
  });
  expect(mobilePickerSurface.backgroundColor).not.toBe("transparent");
  expect(mobilePickerSurface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(mobilePickerSurface.borderTopWidth).not.toBe("0px");
  await page.locator('[data-role="chat-mobile-agent-option-supervisor"]').click();
  await expect.poll(async () => (await readSessionLogCount(page, "sessions.subscribe")) > afterDataSubscribeCount).toBe(true);
  await expect(page.locator('[data-role="chat-mobile-agent-picker-trigger"]')).toContainText("Supervisor");
  await expect(page.locator('[data-role="chat-mobile-agent-picker"]')).toHaveCount(0);
});

test("chat page session actions can reload the current agent chat without overwriting the Sessions selection", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('.session-list-link--active[data-role="session-link"]')).toHaveCount(1);
  await expect.poll(async () => page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id")).toBeTruthy();

  const initialSessionsSessionId = await page.locator('.session-list-link--active[data-role="session-link"]').getAttribute("data-session-id");
  const initialSessionsTitle = (await page.locator('[data-role="selected-session-title"]').textContent())?.trim() ?? "";
  expect(initialSessionsSessionId).toBeTruthy();
  expect(initialSessionsTitle).toBeTruthy();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionsSessionId ?? "");

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");

  const firstSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(firstSessionId).toBeTruthy();

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(0);

  const secondSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(secondSessionId).toBeTruthy();
  expect(secondSessionId).not.toBe(firstSessionId);

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-reload"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session reloaded.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("/reload");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", secondSessionId ?? "");
  await expect.poll(async () => page.evaluate(() => window.location.search)).not.toContain("selectedSessionId=");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(2);
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionsSessionId ?? "");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText(initialSessionsTitle);

  const selectedSessionId = await page.locator('.session-list-link--active[data-role="session-link"]').getAttribute("data-session-id");
  expect(selectedSessionId).toBe(initialSessionsSessionId);
  expect(selectedSessionId).not.toBe(secondSessionId);
  await expect.poll(async () => page.evaluate(() => window.location.search)).toContain(`selectedSessionId=${initialSessionsSessionId}`);

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", secondSessionId ?? "");
});

test("sessions navigation does not inherit the Supervisor chat session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('.session-list-link--active[data-role="session-link"]')).toHaveCount(1);
  await expect.poll(async () => page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id")).toBeTruthy();

  const initialSessionsSessionId = await page.locator('.session-list-link--active[data-role="session-link"]').getAttribute("data-session-id");
  const initialSessionsTitle = (await page.locator('[data-role="selected-session-title"]').textContent())?.trim() ?? "";
  expect(initialSessionsSessionId).toBeTruthy();
  expect(initialSessionsTitle).toBeTruthy();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionsSessionId ?? "");

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-supervisor"]').click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");

  const supervisorChatSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(supervisorChatSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(() => window.location.search)).not.toContain("selectedSessionId=");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionsSessionId ?? "");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText(initialSessionsTitle);
  await expect(page.locator('[data-role="selected-session-title"]')).not.toContainText("Supervisor chat");

  const selectedSessionId = await page.locator('.session-list-link--active[data-role="session-link"]').getAttribute("data-session-id");
  expect(selectedSessionId).toBe(initialSessionsSessionId);
  expect(selectedSessionId).not.toBe(supervisorChatSessionId);
  await expect.poll(async () => page.evaluate(() => window.location.search)).toContain(`selectedSessionId=${initialSessionsSessionId}`);

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-supervisor"]').click();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", supervisorChatSessionId ?? "");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
});

test("chat page reuses a cached main session from the session list before reopening the agent runtime", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.agents",
      JSON.stringify([
        {
          id: "agent-supervisor-fixed",
          slug: "supervisor",
          name: "Supervisor",
          description: "Built-in protected Orchestra supervisor agent.",
          systemPrompt: "Supervisor prompt",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: ["policy-supervisor"],
          directPermissions: [],
          system: true,
          immutable: true,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "agent-data-fixed",
          slug: "data",
          name: "Data",
          description: "Persistent collaborator for implementation and documentation work.",
          systemPrompt: "Keep context, preserve continuity, and move the project forward.",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
          system: false,
          immutable: false,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.agent-runtimes",
      JSON.stringify([
        {
          projectId: "orchestra",
          agentId: "agent-supervisor-fixed",
          status: "idle",
          mainSessionId: null,
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          projectId: "orchestra",
          agentId: "agent-data-fixed",
          status: "idle",
          mainSessionId: "session-data-main",
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-data-main",
          title: "Cached data session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "cached-event-1",
              kind: "assistant",
              message: "Cached response from the existing main session.",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-data-main");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Cached response from the existing main session.");
});

test("chat entry resets auto-scroll on return and keeps following new messages", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const sessionId = "session-data-main";
  const seededSession = {
    id: sessionId,
    title: "Cached data session",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: false,
    events: buildMockSessionEvents(80, "Data cached event"),
  };

  await page.addInitScript(({ nextTimestamp, nextSession }) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.agents",
      JSON.stringify([
        {
          id: "agent-supervisor-fixed",
          slug: "supervisor",
          name: "Supervisor",
          description: "Built-in protected Orchestra supervisor agent.",
          systemPrompt: "Supervisor prompt",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: ["policy-supervisor"],
          directPermissions: [],
          system: true,
          immutable: true,
          archived: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
        {
          id: "agent-data-fixed",
          slug: "data",
          name: "Data",
          description: "Persistent collaborator for implementation and documentation work.",
          systemPrompt: "Keep context, preserve continuity, and move the project forward.",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
          system: false,
          immutable: false,
          archived: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.agent-runtimes",
      JSON.stringify([
        {
          projectId: "orchestra",
          agentId: "agent-supervisor-fixed",
          status: "idle",
          mainSessionId: null,
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
        {
          projectId: "orchestra",
          agentId: "agent-data-fixed",
          status: "idle",
          mainSessionId: nextSession.id,
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([nextSession]));
  }, { nextTimestamp: timestamp, nextSession: seededSession });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event immediately after chat entry", "test.chat_entry_live_after_open");
  await expect(transcript).toContainText("Newest event immediately after chat entry");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await scrollTranscriptUp(transcript);
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "off");
  await expectTranscriptNotAtBottom(transcript);

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event immediately after returning to chat", "test.chat_entry_live_after_return");
  await expect(transcript).toContainText("Newest event immediately after returning to chat");
  await expectTranscriptAutoScrollOn(transcript, toggle);
});

test("chat page recovers the active agent session after a prolonged background refresh miss", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-supervisor"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Keep this chat session visible");

  const initialSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(initialSessionId).toBeTruthy();

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = Date.now();
    Date.now = () => testWindow.__orchestraTestNow ?? 0;
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep this chat session visible");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();
  await expect(page.locator('[data-role="agent-chat-status-error"]')).toHaveCount(0);

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = (testWindow.__orchestraTestNow ?? Date.now()) + 30_000;
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionId ?? "");
  await expect(page.locator('[data-role="composer-input"]')).toBeVisible();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep this chat session visible");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();
  await expect(page.locator('[data-role="agent-chat-status-error"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="session-chat-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="agent-chat-status-error"]')).toHaveCount(0);
});

test("chat page recreates a missing agent main session without losing the draft", async ({ page }) => {
  const timestamp = new Date().toISOString();

  await page.addInitScript(({ nextTimestamp }) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.agents",
      JSON.stringify([
        {
          id: "agent-supervisor-fixed",
          slug: "supervisor",
          name: "Supervisor",
          description: "Built-in protected Orchestra supervisor agent.",
          systemPrompt: "Supervisor prompt",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: ["policy-supervisor"],
          directPermissions: [],
          system: true,
          immutable: true,
          archived: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
        {
          id: "agent-data-fixed",
          slug: "data",
          name: "Data",
          description: "Persistent collaborator for implementation and documentation work.",
          systemPrompt: "Keep context, preserve continuity, and move the project forward.",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
          system: false,
          immutable: false,
          archived: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.agent-runtimes",
      JSON.stringify([
        {
          projectId: "orchestra",
          agentId: "agent-supervisor-fixed",
          status: "idle",
          mainSessionId: null,
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
        {
          projectId: "orchestra",
          agentId: "agent-data-fixed",
          status: "idle",
          mainSessionId: "session-data-main",
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-data-main",
          title: "Cached data session",
          status: "active",
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
          subscribed: false,
          events: [
            {
              id: "cached-event-1",
              kind: "assistant",
              message: "Cached response from the existing main session.",
              timestamp: nextTimestamp,
            },
          ],
        },
      ]),
    );
  }, { nextTimestamp: timestamp });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const initialSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(initialSessionId).toBe("session-data-main");

  await page.locator('[data-role="composer-input"]').fill("Preserve this draft during recovery");

  await page.evaluate(() => {
    const runtimes = JSON.parse(window.localStorage.getItem("orchestra.mock.agent-runtimes") ?? "[]") as Array<Record<string, unknown>>;
    const updated = runtimes.map((runtime) =>
      runtime.agentId === "agent-data-fixed"
        ? {
            ...runtime,
            mainSessionId: "session-data-missing",
            updatedAt: new Date().toISOString(),
          }
        : runtime,
    );
    window.localStorage.setItem("orchestra.mock.agent-runtimes", JSON.stringify(updated));
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
  });

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toBeVisible();
  const recoveredSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(recoveredSessionId).toBeTruthy();
  expect(recoveredSessionId).not.toBe(initialSessionId);
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Preserve this draft during recovery");
  await expect(page.locator('[data-role="agent-chat-status-error"]')).toHaveCount(0);

  const runtimeMainSessionId = await page.evaluate(() => {
    const runtimes = JSON.parse(window.localStorage.getItem("orchestra.mock.agent-runtimes") ?? "[]") as Array<Record<string, unknown>>;
    return runtimes.find((runtime) => runtime.agentId === "agent-data-fixed")?.mainSessionId ?? null;
  });
  expect(runtimeMainSessionId).toBe(recoveredSessionId);
});


test("chat page cold-opens a replacement agent session when the stored main session is missing", async ({ page }) => {
  const timestamp = new Date().toISOString();

  await page.addInitScript(({ nextTimestamp }) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.agent-runtimes",
      JSON.stringify([
        {
          projectId: "orchestra",
          agentId: "agent-supervisor",
          status: "idle",
          mainSessionId: "missing-session-cold-open",
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
  }, { nextTimestamp: timestamp });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-supervisor"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="session-chat-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="agent-chat-status-error"]')).toHaveCount(0);

  const recoveredSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(recoveredSessionId).toBeTruthy();
  expect(recoveredSessionId).not.toBe("missing-session-cold-open");

  const runtimeMainSessionId = await page.evaluate(() => {
    const runtimes = JSON.parse(window.localStorage.getItem("orchestra.mock.agent-runtimes") ?? "[]") as Array<Record<string, unknown>>;
    return runtimes.find((runtime) => runtime.agentId === "agent-supervisor")?.mainSessionId ?? null;
  });
  expect(runtimeMainSessionId).toBe(recoveredSessionId);
});
