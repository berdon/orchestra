import { expect, test } from "@playwright/test";
import {
  appendMockSessionEvent,
  buildMockSessionEvents,
  expectTranscriptAutoScrollOn,
  expectTranscriptNotAtBottom,
  scrollTranscriptUp,
} from "./session-scroll-helpers";

async function measureSessionLayout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const pageScroller = document.scrollingElement as HTMLElement | null;
    const content = document.querySelector('.content') as HTMLElement | null;
    const contentBody = document.querySelector('.content__body') as HTMLDivElement | null;
    const stack = document.querySelector('.panel-stack--sessions') as HTMLElement | null;
    const shell = document.querySelector('.session-shell') as HTMLElement | null;
    const listPanel = document.querySelector('.session-list-panel--desktop') as HTMLElement | null;
    const detailColumn = document.querySelector('.session-detail-column') as HTMLElement | null;
    const panel = document.querySelector('[data-role="session-chat-panel"]') as HTMLElement | null;
    const transcript = document.querySelector('[data-role="session-transcript"]') as HTMLDivElement | null;
    const composerInput = document.querySelector('[data-role="composer-input"]') as HTMLTextAreaElement | null;
    const composerFooter = document.querySelector('.composer__footer') as HTMLDivElement | null;
    const sendButton = document.querySelector('[data-role="send-message"]') as HTMLButtonElement | null;
    const modelSelect = document.querySelector('.session-model-field--composer .select-input') as HTMLSelectElement | null;
    const panelHeader = panel?.querySelector('.panel__header') as HTMLElement | null;
    const mobileSessionPicker = document.querySelector('[data-role="sessions-mobile-switcher"]') as HTMLElement | null;
    const mobilePickerTrigger = document.querySelector('[data-role="sessions-mobile-picker-trigger"]') as HTMLElement | null;
    const mobileTranscriptControlsTrigger = document.querySelector('[data-role="session-mobile-transcript-controls-trigger"]') as HTMLElement | null;
    const mobilePickerCurrent = document.querySelector('.page-mobile-switcher--sessions .page-mobile-switcher__current') as HTMLElement | null;
    const mobilePickerSheet = document.querySelector('[data-role="sessions-mobile-picker"]') as HTMLElement | null;
    const createSessionFabButton = document.querySelector('[data-role="sessions-create-fab"] [data-role="create-session"]') as HTMLButtonElement | null;

    if (!content || !contentBody || !stack || !detailColumn || !panel || !transcript || !composerInput) {
      return null;
    }

    const detailRect = detailColumn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const transcriptRect = transcript.getBoundingClientRect();
    const composerRect = composerInput.getBoundingClientRect();
    const composerFooterRect = composerFooter?.getBoundingClientRect() ?? null;
    const sendRect = sendButton?.getBoundingClientRect() ?? null;
    const modelRect = modelSelect?.getBoundingClientRect() ?? null;
    const triggerRect = mobilePickerTrigger?.getBoundingClientRect() ?? null;
    const mobileTranscriptControlsRect = mobileTranscriptControlsTrigger?.getBoundingClientRect() ?? null;
    const sheetRect = mobilePickerSheet?.getBoundingClientRect() ?? null;
    const fabRect = createSessionFabButton?.getBoundingClientRect() ?? null;
    const pickerCurrentStyle = mobilePickerCurrent ? window.getComputedStyle(mobilePickerCurrent) : null;

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      pageScrollHeight: pageScroller?.scrollHeight ?? null,
      pageClientHeight: pageScroller?.clientHeight ?? null,
      pageScrollable: pageScroller ? pageScroller.scrollHeight - pageScroller.clientHeight > 1 : false,
      contentHeight: content.getBoundingClientRect().height,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      contentOverflowY: window.getComputedStyle(content).overflowY,
      contentScrollable: content.scrollHeight - content.clientHeight > 1,
      contentBodyHeight: contentBody.getBoundingClientRect().height,
      stackHeight: stack.getBoundingClientRect().height,
      shellGridColumns: shell ? window.getComputedStyle(shell).gridTemplateColumns : null,
      listPanelWidth: listPanel ? listPanel.getBoundingClientRect().width : 0,
      detailHeight: detailRect.height,
      detailTop: detailRect.top,
      detailClientHeight: detailColumn.clientHeight,
      detailScrollHeight: detailColumn.scrollHeight,
      detailOverflowY: window.getComputedStyle(detailColumn).overflowY,
      detailScrollable: detailColumn.scrollHeight - detailColumn.clientHeight > 1
        && ["auto", "scroll", "overlay"].includes(window.getComputedStyle(detailColumn).overflowY),
      panelHeight: panelRect.height,
      panelTop: panelRect.top,
      panelHeaderVisible: panelHeader ? window.getComputedStyle(panelHeader).display !== 'none' : false,
      mobilePickerTop: mobileSessionPicker?.getBoundingClientRect().top ?? null,
      transcriptHeight: transcriptRect.height,
      transcriptTop: transcriptRect.top,
      transcriptClientHeight: transcript.clientHeight,
      transcriptScrollHeight: transcript.scrollHeight,
      transcriptOverflowY: window.getComputedStyle(transcript).overflowY,
      transcriptScrollable: transcript.scrollHeight - transcript.clientHeight > 1
        && ["auto", "scroll", "overlay"].includes(window.getComputedStyle(transcript).overflowY),
      composerInputHeight: composerRect.height,
      composerInputWidth: composerRect.width,
      composerFooterWidth: composerFooterRect?.width ?? 0,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      sendBottom: sendRect?.bottom ?? null,
      sendDisabled: sendButton?.disabled ?? null,
      modelWidth: modelRect?.width ?? null,
      mobilePickerRight: triggerRect?.right ?? null,
      mobileTranscriptControlsLeft: mobileTranscriptControlsRect?.left ?? null,
      mobileTranscriptControlsRight: mobileTranscriptControlsRect?.right ?? null,
      mobilePickerSheetRight: sheetRect?.right ?? null,
      mobilePickerCurrentOverflow: pickerCurrentStyle?.overflow ?? null,
      mobilePickerCurrentTextOverflow: pickerCurrentStyle?.textOverflow ?? null,
      mobilePickerCurrentWhiteSpace: pickerCurrentStyle?.whiteSpace ?? null,
      fabRightInset: fabRect ? window.innerWidth - fabRect.right : null,
      fabBottomInset: fabRect ? window.innerHeight - fabRect.bottom : null,
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

async function appendMockSessionEvents(page: import("@playwright/test").Page, sessionId: string, count = 80) {
  await page.evaluate(({ nextSessionId, nextCount }) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const baseTime = Date.now();
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== nextSessionId) {
        return session;
      }
      const extraEvents = Array.from({ length: nextCount }, (_, index) => ({
        id: `layout-event-${index}`,
        kind: index % 2 === 0 ? "user" : "assistant",
        message: `Layout resize event ${index}\n${"chat ".repeat(40)}`,
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
        reason: "test.session_layout_resize",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, { nextSessionId: sessionId, nextCount: count });
}

async function triggerShortcut(page: import("@playwright/test").Page, key: string) {
  await page.evaluate((nextKey) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: nextKey, ctrlKey: true, bubbles: true }));
  }, key);
}

async function readStoredSupervisorQuickChat(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("orchestra.quick-chat.supervisor.orchestra");
    return raw ? JSON.parse(raw) as { sessionId?: string | null; draft?: string } : null;
  });
}

async function readSessionRefreshCount(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number };
    };
    return testWindow.__orchestraTestSessionRefreshStats ? testWindow.__orchestraTestSessionRefreshStats().listRefreshCount : 0;
  });
}

test("sessions UI creates a session and streams a mock reply", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  const createSessionButton = page.locator('[data-role="create-session"]');
  await expect(page.locator('.page-header')).toHaveCount(0);
  await expect(page.locator('[data-role="app-version-label"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-supervisor-quick-chat"]')).toHaveCount(0);
  await expect(page.locator('[data-role="sessions-create-fab"]')).toBeVisible();
  await expect(createSessionButton).toBeVisible();

  const fabGeometry = await page.evaluate(() => {
    const fab = document.querySelector('[data-role="sessions-create-fab"]');
    const button = document.querySelector('[data-role="create-session"]');
    if (!(fab instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      return null;
    }
    const fabRect = fab.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      fabRightInset: Math.round(window.innerWidth - fabRect.right),
      fabBottomInset: Math.round(window.innerHeight - fabRect.bottom),
      buttonWidth: Math.round(buttonRect.width),
      buttonHeight: Math.round(buttonRect.height),
    };
  });

  expect(fabGeometry).not.toBeNull();
  expect(fabGeometry?.fabRightInset ?? 999).toBeLessThanOrEqual(40);
  expect(fabGeometry?.fabBottomInset ?? 999).toBeLessThanOrEqual(220);
  expect(fabGeometry?.buttonWidth ?? 0).toBeGreaterThan(140);
  expect(fabGeometry?.buttonHeight ?? 0).toBeGreaterThanOrEqual(48);

  const previousSessionCount = await page.locator('[data-role="session-link"]').count();
  await createSessionButton.click();

  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("New session");
  await expect(page.locator('.field-group__label').filter({ hasText: /^Send$/ })).toHaveCount(0);
  await expect(page.locator('[data-role="send-message"]')).not.toContainText("Send");

  await page.locator('[data-role="composer-input"]').fill("Hello from Playwright");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from Playwright", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Acknowledged: Hello from Playwright", { timeout: 20_000 });
});

test("sessions page hides shared header controls on mobile while keeping session creation available", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const createSessionFab = page.locator('[data-role="sessions-create-fab"]');
  const createSessionButton = createSessionFab.locator('[data-role="create-session"]');
  await expect(page.locator('.page-header')).toHaveCount(0);
  await expect(page.locator('[data-role="app-version-label"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-supervisor-quick-chat"]')).toHaveCount(0);
  await expect(createSessionFab).toBeVisible();
  await expect(createSessionButton).toBeVisible();

  const initialFabInsets = await page.evaluate(() => {
    const button = document.querySelector('[data-role="sessions-create-fab"] [data-role="create-session"]');
    if (!(button instanceof HTMLElement)) {
      return null;
    }
    const rect = button.getBoundingClientRect();
    return {
      rightInset: window.innerWidth - rect.right,
      bottomInset: window.innerHeight - rect.bottom,
    };
  });
  expect(initialFabInsets).not.toBeNull();
  expect(initialFabInsets?.rightInset ?? 999).toBeGreaterThanOrEqual(8);
  expect(initialFabInsets?.rightInset ?? 999).toBeLessThanOrEqual(24);
  expect(initialFabInsets?.bottomInset ?? 999).toBeGreaterThanOrEqual(8);
  expect(initialFabInsets?.bottomInset ?? 999).toBeLessThanOrEqual(24);

  await createSessionButton.click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("New session");
  await expect(createSessionFab).toHaveCount(0);
  await expect(page.locator('.field-group__label').filter({ hasText: /^Send$/ })).toHaveCount(0);
  await expect(page.locator('[data-role="send-message"]')).not.toContainText("Send");

  const previousSessionCount = await page.locator('[data-role="session-link"]').count();
  await page.locator('[data-role="session-actions-trigger"]').click();
  await expect(page.locator('[data-role="session-actions-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="session-action-new"]')).toBeEnabled();
  await page.locator('[data-role="session-action-new"]').click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("New session");
  await expect(createSessionFab).toHaveCount(0);

  await page.locator('[data-role="composer-input"]').fill("Hello from mobile sessions");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from mobile sessions", { timeout: 10_000 });

  const activeLayout = await measureSessionLayout(page);
  expect(activeLayout).not.toBeNull();
  expect(activeLayout?.composerBottom ?? 999).toBeLessThanOrEqual((activeLayout?.viewportHeight ?? 0) - 8);
  expect(activeLayout?.sendBottom ?? 999).toBeLessThanOrEqual((activeLayout?.viewportHeight ?? 0) - 8);

  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="new-task"]')).toHaveCount(0);
  await expect(page.locator('[data-role="mobile-supervisor-chat-fab"]')).toBeVisible();
});

test("sessions transcript fills the available page height while the composer remains the resizable surface", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  const panel = page.locator('[data-role="session-chat-panel"]');
  const transcript = page.locator('[data-role="session-transcript"]');

  await expect(panel).toBeVisible();
  await expect(transcript).toBeVisible();

  const initialLayout = await measureSessionLayout(page);
  expect(initialLayout).not.toBeNull();
  expect(initialLayout?.pageScrollable).toBe(false);
  expect(initialLayout?.contentOverflowY).toBe("hidden");
  expect(initialLayout?.contentScrollable).toBe(false);
  expect(initialLayout?.stackHeight ?? 0).toBeGreaterThan((initialLayout?.contentBodyHeight ?? 0) - 24);
  expect(initialLayout?.listPanelWidth ?? 0).toBeGreaterThan(220);
  expect(initialLayout?.detailHeight ?? 0).toBeGreaterThan((initialLayout?.contentBodyHeight ?? 0) * 0.8);
  expect(initialLayout?.detailScrollable).toBe(false);
  expect(initialLayout?.panelHeight ?? 0).toBeGreaterThan((initialLayout?.detailHeight ?? 0) * 0.85);
  expect(initialLayout?.panelHeaderVisible).toBe(true);
  expect(initialLayout?.transcriptHeight ?? 0).toBeGreaterThan(400);
  expect(initialLayout?.transcriptOverflowY).toBe("auto");
  expect(initialLayout?.panelResize).toBe("none");
  expect(initialLayout?.composerResize).toBe("vertical");

  const sessionId = await panel.getAttribute("data-session-id");
  expect(sessionId).toBeTruthy();
  await appendMockSessionEvents(page, sessionId ?? "", 160);
  await expect(transcript).toContainText("Layout resize event 159");

  const beforeResize = await measureSessionLayout(page);
  expect(beforeResize).not.toBeNull();
  expect(beforeResize?.pageScrollable).toBe(false);
  expect(beforeResize?.contentScrollable).toBe(false);
  expect(beforeResize?.detailScrollable).toBe(false);
  expect(beforeResize?.transcriptScrollable).toBe(true);
  expect((beforeResize?.transcriptScrollHeight ?? 0) - (beforeResize?.transcriptClientHeight ?? 0)).toBeGreaterThan(200);

  await dragComposerResizeCorner(page);
  await page.waitForTimeout(100);

  const afterResize = await measureSessionLayout(page);
  expect(afterResize).not.toBeNull();
  expect(afterResize?.pageScrollable).toBe(false);
  expect(afterResize?.contentScrollable).toBe(false);
  expect(afterResize?.detailScrollable).toBe(false);
  expect(afterResize?.transcriptScrollable).toBe(true);
  expect(afterResize?.composerInputHeight ?? 0).toBeGreaterThan((beforeResize?.composerInputHeight ?? 0) + 100);
  expect(afterResize?.transcriptHeight ?? 0).toBeLessThan((beforeResize?.transcriptHeight ?? 0) - 100);
  expect(Math.abs((afterResize?.panelHeight ?? 0) - (beforeResize?.panelHeight ?? 0))).toBeLessThan(8);
  expect((afterResize?.transcriptScrollHeight ?? 0) - (afterResize?.transcriptClientHeight ?? 0)).toBeGreaterThan(200);

  await transcript.evaluate((element) => {
    const log = element as HTMLDivElement;
    log.scrollTop = 0;
    log.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(transcript).toHaveAttribute("data-scroll-locked", "false");
});

test("sessions switches to the page-local picker mode at 1024px so the detail pane stays usable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  await expect(page.locator('[data-role="sessions-mobile-picker-trigger"]')).toBeVisible();
  await expect(page.locator('.session-list-panel--desktop')).toBeHidden();

  const layout = await measureSessionLayout(page);
  expect(layout).not.toBeNull();
  expect(layout?.detailTop ?? 999).toBeLessThan(180);
  expect(layout?.transcriptHeight ?? 0).toBeGreaterThan(180);
});

test("sessions list uses deterministic task ordering and delays the dismiss affordance until hover settles", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-late",
          title: "runtime-z",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
          taskId: "task-10",
          taskNumber: "ORC-10",
          taskTitle: "Tenth task",
          workerType: "agent",
          workerName: "Reviewer",
        },
        {
          id: "session-early",
          title: "runtime-a",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
          taskId: "task-2",
          taskNumber: "ORC-2",
          taskTitle: "Second task",
          workerType: "agent",
          workerName: "Builder",
        },
      ]),
    );
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("ORC-2");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("Second task");

  const firstRow = page.locator('.session-list-row').first();
  const dismissButton = firstRow.locator('.session-delete-button');
  await expect(dismissButton).toHaveJSProperty('tabIndex', -1);
  await firstRow.hover();
  await page.waitForTimeout(2100);
  await expect(firstRow).toHaveClass(/session-list-row--actions-visible/);
  await expect(dismissButton).toHaveJSProperty('tabIndex', 0);
});

test("sessions mobile mirrors chat with a lightweight page-local session picker and single-column detail view", async ({ page }) => {
  const timestamp = new Date().toISOString();
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.evaluate(({ nextTimestamp }) => {
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-mobile-1",
          title: "Mobile planning session",
          status: "active",
          createdAt: nextTimestamp,
          updatedAt: new Date(new Date(nextTimestamp).getTime() + 1_000).toISOString(),
          subscribed: false,
          events: [
            {
              id: "mobile-session-event-1",
              kind: "assistant",
              message: "First mobile transcript entry.",
              timestamp: nextTimestamp,
            },
          ],
        },
        {
          id: "session-mobile-2",
          title: "Mobile follow-up session",
          status: "active",
          createdAt: nextTimestamp,
          updatedAt: new Date(new Date(nextTimestamp).getTime() + 2_000).toISOString(),
          subscribed: false,
          events: [
            {
              id: "mobile-session-event-2",
              kind: "assistant",
              message: "Second mobile transcript entry.",
              timestamp: new Date(new Date(nextTimestamp).getTime() + 2_000).toISOString(),
            },
          ],
        },
      ]),
    );
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: ["session-mobile-1", "session-mobile-2"],
        reason: "test.mobile_session_picker_seed",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, { nextTimestamp: timestamp });

  await expect(page.locator('[data-role="sessions-mobile-picker-trigger"]')).toBeVisible();
  await expect(page.locator('.session-list-panel--desktop')).toBeHidden();

  await page.locator('[data-role="sessions-mobile-picker-trigger"]').click();
  await expect(page.locator('[data-role="sessions-mobile-picker"]')).toBeVisible();
  await expect(page.locator('[data-role="sessions-mobile-picker"] [data-role="session-link"][data-session-id="session-mobile-1"]')).toBeVisible();

  await page.locator('[data-role="sessions-mobile-picker"] [data-role="session-link"][data-session-id="session-mobile-1"]').click();
  await expect(page.locator('[data-role="sessions-mobile-picker"]')).toHaveCount(0);
  await expect(page.locator('[data-role="sessions-mobile-picker-trigger"]')).toContainText("Mobile planning session");
  await expect(page.locator('[data-role="session-mobile-transcript-controls-trigger"]')).toBeVisible();
  await expect(page.locator('[data-role="sessions-create-fab"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-chat-panel"] > .panel__header')).toBeHidden();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("First mobile transcript entry.");

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await expect(page.locator('[data-role="session-mobile-transcript-controls-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="session-mobile-wrap-toggle"]')).toHaveAttribute("data-wrap-mode", "wrap");
  await page.locator('[data-role="session-mobile-wrap-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-wrap-mode", "nowrap");

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await expect(page.locator('[data-role="session-mobile-auto-scroll-toggle"]')).toHaveAttribute("data-auto-scroll-mode", "on");
  await page.locator('[data-role="session-mobile-auto-scroll-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-scroll-locked", "false");

  await page.locator('[data-role="session-mobile-transcript-controls-trigger"]').click();
  await page.locator('[data-role="session-mobile-auto-scroll-toggle"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toHaveAttribute("data-scroll-locked", "true");

  await page.locator('[data-role="composer-input"]').fill("Reply from mobile sessions test");
  await page.locator('[data-role="send-message"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Reply from mobile sessions test", { timeout: 10_000 });

  const mobileLayout = await measureSessionLayout(page);
  expect(mobileLayout).not.toBeNull();
  expect(mobileLayout?.panelTop ?? 999).toBeLessThan(330);
  expect(mobileLayout?.mobilePickerTop ?? 999).toBeLessThan(mobileLayout?.panelTop ?? 999);
  expect((mobileLayout?.mobileTranscriptControlsLeft ?? 0) - (mobileLayout?.mobilePickerRight ?? 0)).toBeGreaterThanOrEqual(0);
  expect((mobileLayout?.mobileTranscriptControlsLeft ?? 999) - (mobileLayout?.mobilePickerRight ?? 0)).toBeLessThanOrEqual(12);
  expect(mobileLayout?.mobileTranscriptControlsRight ?? 999).toBeLessThanOrEqual(mobileLayout?.viewportWidth ?? 0);
  expect(mobileLayout?.panelHeaderVisible).toBe(false);
  expect(mobileLayout?.transcriptHeight ?? 0).toBeGreaterThan(120);
  expect(mobileLayout?.transcriptTop ?? 999).toBeLessThan((mobileLayout?.viewportHeight ?? 0) - 180);
  expect(Math.abs((mobileLayout?.composerFooterWidth ?? 0) - (mobileLayout?.composerInputWidth ?? 0))).toBeLessThanOrEqual(2);
  expect(mobileLayout?.composerBottom ?? 999).toBeLessThanOrEqual((mobileLayout?.viewportHeight ?? 0) - 8);
  expect(mobileLayout?.sendBottom ?? 999).toBeLessThanOrEqual((mobileLayout?.viewportHeight ?? 0) - 8);
  expect(mobileLayout?.sendDisabled).toBe(false);
  expect(mobileLayout?.modelWidth ?? 999).toBeLessThan((mobileLayout?.composerInputWidth ?? 0) * 0.6);
  expect(mobileLayout?.documentScrollWidth ?? 999).toBeLessThanOrEqual(mobileLayout?.viewportWidth ?? 0);

  await page.locator('[data-role="sessions-mobile-picker-trigger"]').click();
  await page.locator('[data-role="sessions-mobile-picker"] [data-role="session-link"][data-session-id="session-mobile-2"]').click();
  await expect(page.locator('[data-role="sessions-mobile-picker-trigger"]')).toContainText("Mobile follow-up session");
  await expect(page.locator('[data-role="sessions-mobile-picker"]')).toHaveCount(0);
});

test("sessions mobile truncates long session labels without horizontal overflow or hidden controls", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const longTitle = `Mobile overflow regression ${"session ".repeat(18)}${"X".repeat(120)}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.evaluate(({ nextTimestamp, nextLongTitle }) => {
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-mobile-long-label",
          title: nextLongTitle,
          status: "active",
          createdAt: nextTimestamp,
          updatedAt: nextTimestamp,
          subscribed: false,
          events: [
            {
              id: "mobile-long-label-event-1",
              kind: "assistant",
              message: "Long-label mobile transcript entry.",
              timestamp: nextTimestamp,
            },
          ],
        },
      ]),
    );
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: ["session-mobile-long-label"],
        reason: "test.mobile_long_label_seed",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, { nextTimestamp: timestamp, nextLongTitle: longTitle });

  const trigger = page.locator('[data-role="sessions-mobile-picker-trigger"]');
  await expect(trigger).toBeVisible();

  if ((await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id")) !== "session-mobile-long-label") {
    await trigger.click();
    await page.locator('[data-role="sessions-mobile-picker"] [data-role="session-link"][data-session-id="session-mobile-long-label"]').click();
  }

  await expect(trigger).toContainText("Mobile overflow regression");
  await page.locator('[data-role="composer-input"]').fill("Reply after long label");
  await page.locator('[data-role="send-message"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Reply after long label", { timeout: 10_000 });

  const closedLayout = await measureSessionLayout(page);
  expect(closedLayout).not.toBeNull();
  expect(closedLayout?.documentScrollWidth ?? 999).toBeLessThanOrEqual(closedLayout?.viewportWidth ?? 0);
  expect(closedLayout?.mobilePickerRight ?? 999).toBeLessThanOrEqual(closedLayout?.viewportWidth ?? 0);
  expect(closedLayout?.mobileTranscriptControlsRight ?? 999).toBeLessThanOrEqual(closedLayout?.viewportWidth ?? 0);
  expect((closedLayout?.mobileTranscriptControlsLeft ?? 0) - (closedLayout?.mobilePickerRight ?? 0)).toBeGreaterThanOrEqual(0);
  expect(closedLayout?.mobilePickerCurrentOverflow).toBe("hidden");
  expect(closedLayout?.mobilePickerCurrentTextOverflow).toBe("ellipsis");
  expect(closedLayout?.mobilePickerCurrentWhiteSpace).toBe("nowrap");
  expect(closedLayout?.transcriptHeight ?? 0).toBeGreaterThan(80);
  expect(closedLayout?.composerBottom ?? 999).toBeLessThanOrEqual((closedLayout?.viewportHeight ?? 0) - 8);
  expect(closedLayout?.sendBottom ?? 999).toBeLessThanOrEqual((closedLayout?.viewportHeight ?? 0) - 8);
  expect(closedLayout?.sendDisabled).toBe(false);

  await trigger.click();
  await expect(page.locator('[data-role="sessions-mobile-picker"]')).toBeVisible();

  const openLayout = await measureSessionLayout(page);
  expect(openLayout).not.toBeNull();
  expect(openLayout?.documentScrollWidth ?? 999).toBeLessThanOrEqual(openLayout?.viewportWidth ?? 0);
  expect(openLayout?.mobilePickerSheetRight ?? 999).toBeLessThanOrEqual(openLayout?.viewportWidth ?? 0);
});

test("sessions mobile session actions menu stays within the viewport", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  await expect(page.locator('[data-role="create-session"]')).toBeVisible();
  await page.locator('[data-role="create-session"]').click();

  const menuTrigger = page.locator('[data-role="session-actions-trigger"]');
  await expect(menuTrigger).toBeVisible();
  await menuTrigger.click();

  const menu = page.locator('[data-role="session-actions-menu"]');
  await expect(menu).toBeVisible();

  const menuBounds = await menu.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(menuBounds.left).toBeGreaterThanOrEqual(-1);
  expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.viewportWidth + 1);
  expect(menuBounds.documentScrollWidth).toBeLessThanOrEqual(menuBounds.viewportWidth);
});

test("sessions secondary nav width is resizable and persists", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  const panel = page.locator('.session-list-panel');
  const handle = page.locator('[data-role="secondary-nav-resize-handle"]').first();
  const initialWidth = await panel.evaluate((node) => node.getBoundingClientRect().width);
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('Expected resize handle bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 72, handleBox.y + handleBox.height / 2, { steps: 6 });
  await page.mouse.up();

  const resizedWidth = await panel.evaluate((node) => node.getBoundingClientRect().width);
  expect(resizedWidth).toBeGreaterThan(initialWidth + 40);

  const storedWidth = await page.evaluate(() => window.localStorage.getItem('orchestra.layout.sessions.secondary-nav-width'));
  expect(Number(storedWidth)).toBeGreaterThan(initialWidth + 40);
});

test("sessions chat shows compact context usage stats for the selected session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  await expect(page.locator('[data-role="session-context-stats"]')).toBeVisible();
  await expect(page.locator('[data-role="session-context-percent"]')).toContainText("context");
  await expect(page.locator('[data-role="session-context-window"]')).toContainText("Window");
  await expect(page.locator('[data-role="session-total-token-usage"]')).toContainText("Used");
  await expect(page.locator('[data-role="session-message-count"]')).toContainText("messages");
});

test("sessions composer model selector is compact, fixed-width, and unlabeled", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('[data-role="create-session"]')).toBeVisible();
  await page.locator('[data-role="create-session"]').click();

  const modelSelect = page.locator('select[aria-label="Session model"]');
  const cogButton = page.locator('[data-role="session-actions-trigger"]');
  const sendButton = page.locator('[data-role="send-message"]');
  await expect(modelSelect).toBeVisible();
  await expect(cogButton).toBeVisible();
  await expect(sendButton).toBeEnabled();
  await expect(page.locator('.session-model-field .field-group__label')).toHaveCount(0);

  const modelWidth = await modelSelect.evaluate((node) => node.getBoundingClientRect().width);
  expect(modelWidth).toBeGreaterThanOrEqual(140);
  expect(modelWidth).toBeLessThanOrEqual(190);

  const layout = await page.evaluate(() => {
    const footer = document.querySelector('.composer__footer') as HTMLDivElement | null;
    const actions = document.querySelector('.composer__actions') as HTMLDivElement | null;
    const cog = document.querySelector('[data-role="session-actions-trigger"]') as HTMLButtonElement | null;
    const send = document.querySelector('[data-role="send-message"]') as HTMLButtonElement | null;
    if (!footer || !actions || !cog || !send) {
      return null;
    }
    const footerRect = footer.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const cogRect = cog.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    return {
      actionsRightGap: Math.abs(footerRect.right - actionsRect.right),
      cogWidth: Math.round(cogRect.width),
      cogHeight: Math.round(cogRect.height),
      sendHeight: Math.round(sendRect.height),
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.actionsRightGap ?? 999).toBeLessThanOrEqual(2);
  expect(layout?.cogWidth).toBe(layout?.cogHeight);
  expect(Math.abs((layout?.cogHeight ?? 0) - (layout?.sendHeight ?? 0))).toBeLessThanOrEqual(6);
});

test("sessions composer session actions can reload, compact the current session, and create a new one", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();
  const initialCount = await page.locator('[data-role="session-link"]').count();

  await page.locator('[data-role="session-actions-trigger"]').click();
  await expect(page.locator('[data-role="session-actions-menu"]')).toBeVisible();
  await page.locator('[data-role="session-action-compact"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session compacted.");

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialCount + 1);
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session is active. Send a message to begin the interaction loop.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("Session compacted.");

  const reloadedSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-reload"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session reloaded.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("/reload");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", reloadedSessionId ?? "");
});

test("sessions composer New session rotates a selected worker-owned session instead of creating a generic detached session", async ({ page }) => {
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
          title: "Data main session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: true,
          events: [
            {
              id: "seed-event-1",
              kind: "assistant",
              message: "Current Data session.",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();

  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(2);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Fresh session is active.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("Current Data session.");
});

test("sessions composer stays enabled while earlier messages are still pending", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  await page.locator('[data-role="composer-input"]').fill("First queued message");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await page.locator('[data-role="composer-input"]').fill("Second queued message");
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();
  await expect(page.locator('[data-role="send-message"]')).not.toContainText("Send");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("First queued message", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Second queued message", { timeout: 10_000 });
});

test("sessions stop button stops an active mock run", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  const longMessage = "Please keep thinking for a while ".repeat(40).trim();
  await page.locator('[data-role="composer-input"]').fill(longMessage);
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="stop-session-runtime"]')).toBeEnabled();
  await page.locator('[data-role="stop-session-runtime"]').click();

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session run stopped by operator.");
  await expect(page.locator('[data-role="stop-session-runtime"]')).toBeDisabled();

  await page.waitForTimeout(1200);
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText(`Acknowledged: ${longMessage}`);
});

test("sessions UI shows tool call composition before tool execution starts", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-toolcall",
          title: "Tool call stream",
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
  await page.getByRole("link", { name: "Tool call stream" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-toolcall",
          runId: "run-toolcall",
          receivedAt,
          event: {
            type: "message_start",
            message: { role: "assistant" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-toolcall",
          runId: "run-toolcall",
          receivedAt,
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  toolCallId: "call-compose-1",
                  toolName: "write_file",
                  input: { path: "src/live.ts", content: "const answer = 42;" },
                },
              ],
            },
            assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial: {} },
          },
        },
      }),
    );
  });

  const transcript = page.locator('[data-role="session-transcript"]');
  await expect(transcript).toContainText("write_file(");
  await expect(transcript).toContainText("src/live.ts");
  await expect(page.locator('[data-role="transcript-event"][data-event-id="tool-execution-call-compose-1"]')).toHaveAttribute("data-event-kind", "system");
});

test("sessions UI shows tool invocations in the transcript", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-tools",
          title: "Show tools",
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
  await page.getByRole("link", { name: "Show tools" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-tools",
          runId: "run-tools",
          receivedAt,
          event: {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "complete_lane_as_success",
            args: { taskId: "task-1", notes: "Ship it" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-tools",
          runId: "run-tools",
          receivedAt,
          event: {
            type: "tool_execution_end",
            toolCallId: "call-1",
            toolName: "complete_lane_as_success",
            args: { taskId: "task-1", notes: "Ship it" },
            result: {
              content: [{ type: "text", text: '{"id":"task-1","status":"done"}' }],
            },
            isError: false,
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("complete_lane_as_success");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("task-1");
});

test("sessions UI shows compact live thinking updates while assistant text streams", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-thinking",
          title: "Thinking stream",
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
  await page.getByRole("link", { name: "Thinking stream" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_start",
            message: { role: "assistant" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "thinking", thinking: "First line\nSecond line" }] },
            assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line" }] },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\nThird line\nFourth line", partial: {} },
          },
        },
      }),
    );
  });

  const thinkingPreview = page.locator('[data-role="transcript-thinking-preview"]').last();
  await expect(thinkingPreview).toContainText("Fourth line");
  const previewTextContent = await thinkingPreview.evaluate((node) => node.textContent || "");
  expect(previewTextContent).toContain("Third line");
  expect(previewTextContent).toContain("Fourth line");
  const webkitLineClamp = await thinkingPreview.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-line-clamp"));
  expect(webkitLineClamp.trim()).toBe("3");

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line\nFifth line" },
                { type: "text", text: "Visible answer" },
              ],
            },
            assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Visible answer", partial: {} },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "turn_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line\nFifth line" },
                { type: "text", text: "Visible answer" },
              ],
            },
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Visible answer");
  await expect(thinkingPreview).toContainText("Fifth line");
});

test("sessions UI shows streamed assistant text when rejoining an active session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-rejoin",
          title: "Rejoin me",
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
  await page.getByRole("link", { name: "Rejoin me" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "message_start",
            message: { role: "assistant" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "Hello from rejoined stream" }] },
            assistantMessageEvent: { type: "text_delta", delta: "Hello from rejoined stream" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "turn_end",
            message: { content: [{ type: "text", text: "Hello from rejoined stream" }] },
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from rejoined stream");
});

test("sessions composer keeps focus while the viewed session refreshes", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-focus-refresh",
          title: "Focus refresh",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep typing while this session updates",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Focus refresh" }).click();
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Draft that should keep focus");

  await page.evaluate(() => {
    window.setTimeout(() => {
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        "orchestra.mock.sessions.orchestra",
        JSON.stringify([
          {
            id: "session-focus-refresh",
            title: "Focus refresh",
            status: "idle",
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: true,
            events: [
              {
                id: "user-1",
                kind: "user",
                message: "Keep typing while this session updates",
                timestamp,
              },
              {
                id: "assistant-1",
                kind: "assistant",
                message: "This refresh should not steal focus.",
                timestamp,
              },
            ],
          },
        ]),
      );
      window.dispatchEvent(new CustomEvent("orchestra:session-change", {
        detail: {
          sessionIds: ["session-focus-refresh"],
          reason: "test.session_focus_refresh",
        },
      }));
      window.dispatchEvent(new Event("focus"));
    }, 150);
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("This refresh should not steal focus.", { timeout: 4000 });
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Draft that should keep focus");
});

test("sessions UI refreshes an active session after opening even without a local send", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-active-refresh",
          title: "Active refresh",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep watching this session",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Active refresh" }).click();

  await page.evaluate(() => {
    window.setTimeout(() => {
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        "orchestra.mock.sessions.orchestra",
        JSON.stringify([
          {
            id: "session-active-refresh",
            title: "Active refresh",
            status: "idle",
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: true,
            events: [
              {
                id: "user-1",
                kind: "user",
                message: "Keep watching this session",
                timestamp,
              },
              {
                id: "assistant-1",
                kind: "assistant",
                message: "This reply arrived after the session was opened.",
                timestamp,
              },
            ],
          },
        ]),
      );
      window.dispatchEvent(new CustomEvent("orchestra:session-change", {
        detail: {
          sessionIds: ["session-active-refresh"],
          reason: "test.session_active_refresh",
        },
      }));
      window.dispatchEvent(new Event("focus"));
    }, 150);
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("This reply arrived after the session was opened.", { timeout: 4000 });
});

test("subscribed active sessions do not keep polling session records every second", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-subscribed-active",
          title: "Subscribed active",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: true,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Live updates already subscribed",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Subscribed active" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  });

  await page.waitForTimeout(2500);

  const finalCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  });

  expect(finalCount).toBe(baselineCount);
});

test("session-change bursts debounce to one background session list refresh", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-debounce",
          title: "Debounce me",
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
  await page.getByRole("link", { name: "Debounce me" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  });

  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new CustomEvent("orchestra:session-change", {
        detail: { sessionIds: ["session-debounce"], reason: `burst-${index}` },
      }));
    }
  });

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBe(baselineCount + 1);
});

test("streaming updates for a newly discovered session debounce into one background session list refresh", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-known",
          title: "Known session",
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
  await page.getByRole("link", { name: "Known session" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  });

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-new-streaming",
          runId: `run-${index}`,
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: `chunk-${index}` }] },
            assistantMessageEvent: { type: "text_delta", delta: `chunk-${index}`, contentIndex: 0, partial: {} },
          },
        },
      }));
    }
  });

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBe(baselineCount + 1);
});

test("sessions page keeps the viewed session stable during a prolonged background refresh miss", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-refresh-miss",
          title: "Refresh miss",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep this session open while the list refreshes",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Refresh miss" }).click();
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Keep typing through the refresh miss");

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.subscribe").length;
  }).toBe(1);

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = Date.now();
    Date.now = () => testWindow.__orchestraTestNow ?? 0;
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Refresh miss");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep typing through the refresh miss");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = (testWindow.__orchestraTestNow ?? Date.now()) + 30_000;
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Refresh miss");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep typing through the refresh miss");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();

  const sessionLogTargets = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]")
    .map((entry: { target?: string }) => entry.target)
    .filter((target: string | undefined) => typeof target === "string" && target.startsWith("sessions.")));
  expect(sessionLogTargets.filter((target: string) => target === "sessions.unsubscribe")).toHaveLength(0);
  expect(sessionLogTargets.filter((target: string) => target === "sessions.subscribe")).toHaveLength(1);
});

test("sessions page filters active and closed task sessions", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-active",
          title: "Active task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
        {
          id: "session-closed",
          title: "Implementation · Closable session task",
          status: "closed",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("Active task session");

  const closedSessionLinks = page.locator('[data-role="session-link"]');
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(closedSessionLinks).toHaveCount(1);
  await expect(closedSessionLinks).toContainText("Implementation · Closable session task");
  await page.waitForTimeout(500);
  await expect(page.locator('[data-role="session-filter-closed"]')).toHaveAttribute("aria-selected", "true");
  await expect(closedSessionLinks).toHaveCount(1);

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(closedSessionLinks).toHaveCount(1);
  await expect(closedSessionLinks).toContainText("Implementation · Closable session task");
});

test("session dismiss hides a closed session without deleting its stored record", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-dismiss-me",
          title: "Dismissable closed session",
          status: "closed",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            { id: "assistant-1", kind: "assistant", message: "Already finished.", timestamp },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(page.locator('[data-role="session-link"]')).toContainText("Dismissable closed session");
  await page.getByRole("button", { name: "Dismiss Dismissable closed session" }).evaluate((element: HTMLButtonElement) => element.click());

  const stored = await page.evaluate(() => ({
    sessions: JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]"),
    dismissed: JSON.parse(window.localStorage.getItem("orchestra.mock.dismissed-sessions.orchestra") ?? "[]"),
  }));
  expect(stored.sessions).toHaveLength(1);
  expect(stored.sessions[0]?.id).toBe("session-dismiss-me");
  expect(stored.dismissed).toContain("session-dismiss-me");

});

test("sessions page hides debug paths behind a dev-only toggle below the chat panel", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-debug-paths",
          title: "Debug path layout",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Session loaded with debug info.",
              timestamp,
            },
          ],
          debugInfo: {
            projectRoot: "/tmp/orchestra/projects/demo",
            managedRepositoryPath: "/tmp/orchestra/projects/demo/repositories/repository",
            worktreePath: "/tmp/orchestra/projects/demo/worktrees/agent-02",
            sessionCwd: "/tmp/orchestra/projects/demo/worktrees/agent-02",
          },
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Debug path layout" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const debugToggle = page.locator('[data-role="show-session-debug"]');
  const debugPanel = page.locator('[data-role="session-debug-paths"]');
  const debugHeading = page.getByRole("heading", { name: "Resolved runtime paths" });

  await expect(transcript).toBeVisible();
  await expect(debugToggle).toBeVisible();
  await expect(debugToggle).toContainText("Show debug information");
  await expect(debugPanel).toHaveCount(0);

  const chatPanelMetrics = await transcript.evaluate((node) => {
    const panel = node.closest(".panel") as HTMLElement | null;
    if (!panel) {
      return null;
    }

    const rect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(panel);
    return {
      y: rect.y,
      height: rect.height,
      bottom: rect.bottom,
      resize: style.resize,
      minHeight: style.minHeight,
    };
  });
  const debugToggleMetrics = await debugToggle.evaluate((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect();
    return { y: rect.y };
  });

  expect(chatPanelMetrics).not.toBeNull();
  expect(debugToggleMetrics.y).toBeGreaterThanOrEqual(chatPanelMetrics!.bottom - 1);
  expect(chatPanelMetrics!.resize).toBe("none");
  expect(chatPanelMetrics!.height).toBeGreaterThan(400);

  const transcriptWrapMinHeight = await transcript.evaluate((node) => window.getComputedStyle(node.parentElement as HTMLElement).minHeight);
  expect(Number.parseFloat(transcriptWrapMinHeight)).toBe(0);

  await debugToggle.click();
  await expect(debugToggle).toHaveCount(0);
  await expect(debugHeading).toBeVisible();
});

test("sessions page can open runtime details and show loaded extensions for the selected session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.harness-settings",
      JSON.stringify({
        extraExtensions: ["npm:pi-example", "./extensions/local-extra.ts"],
        updatedAt: timestamp,
      }),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-runtime-details",
          title: "Runtime details session",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Runtime details are available.",
              timestamp,
            },
          ],
          debugInfo: {
            projectRoot: "/tmp/orchestra/projects/demo",
            sessionCwd: "/tmp/orchestra/projects/demo/worktrees/agent-02",
          },
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Runtime details session" }).click();
  await page.locator('[data-role="open-session-runtime-details"]').click();

  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toBeVisible();
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText("Disabled by --no-extensions");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("extensions/orchestra-tools.ts");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("npm:pi-example");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("./extensions/local-extra.ts");
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText("Disabled by --no-extensions");

  await page.locator('[data-role="close-session-runtime-details"]').click();
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toHaveCount(0);
});

test("sessions page surfaces unsupported reload failures and runtime capability reasons", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-runtime-control-failure",
          title: "Unsupported reload session",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: true,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Waiting for session control feedback.",
              timestamp,
            },
          ],
          controlCapabilities: {
            reload: { status: "unknown", reason: null },
            compact: { status: "supported", reason: null },
            autoCompact: { status: "supported", reason: null },
            effectiveCompactionWindow: "10%",
            effectiveCompactionWindowSource: "global",
          },
          controlOperation: null,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Unsupported reload session" }).click();

  await page.evaluate((sessionId) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const nextTimestamp = new Date().toISOString();
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: any) => {
      if (session.id !== sessionId) {
        return session;
      }
      return {
        ...session,
        updatedAt: nextTimestamp,
        events: [
          ...session.events,
          {
            id: "control-failed",
            kind: "system",
            message: "runtime_control_unsupported",
            timestamp: nextTimestamp,
          },
        ],
        controlCapabilities: {
          reload: { status: "unsupported", reason: "runtime_control_unsupported" },
          compact: { status: "supported", reason: null },
          autoCompact: { status: "unsupported", reason: "compaction_window_disabled" },
          effectiveCompactionWindow: "off",
          effectiveCompactionWindowSource: "role",
        },
        controlOperation: {
          kind: "reload",
          trigger: "manual",
          status: "failed",
          startedAt: "2026-04-08T00:05:00Z",
          finishedAt: "2026-04-08T00:05:02Z",
          message: "runtime_control_unsupported",
        },
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));

    const inject = (window as typeof window & {
      __orchestraTestInjectSessionStream?: (payload: unknown) => void;
    }).__orchestraTestInjectSessionStream;
    inject?.({
      sessionId,
      receivedAt: "2026-04-08T00:05:00Z",
      event: {
        type: "session_control_start",
        operationId: "control-failed",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:05:00Z",
      },
    });
    inject?.({
      sessionId,
      receivedAt: "2026-04-08T00:05:02Z",
      event: {
        type: "session_control_end",
        operationId: "control-failed",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:05:00Z",
        finishedAt: "2026-04-08T00:05:02Z",
        success: false,
        error: "runtime_control_unsupported",
      },
    });
  }, "session-runtime-control-failure");

  await expect(page.locator('[data-role="sessions-status-error"]')).toContainText('Unsupported in this host.');
  await expect(page.locator('[data-role="sessions-status-error"]')).toContainText('runtime_control_unsupported');
  await expect(page.locator('[data-role="session-chat-panel"]')).toContainText('Reload failed');
  await expect(page.locator('[data-role="session-transcript"]')).toContainText('runtime_control_unsupported');
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText('/reload');

  await page.locator('[data-role="open-session-runtime-details"]').click();
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText('Unsupported · runtime_control_unsupported');
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText('Unsupported · compaction_window_disabled');
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText('Effective compaction window');
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText('off');
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText('role');
});

test("sessions transcript wraps long lines by default and can toggle to no-wrap", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const longLine = `LONG-${"x".repeat(600)}`;
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-wrap-toggle",
          title: "Wrap toggle",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: longLine,
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Wrap toggle" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-wrap-toggle"]');
  const firstMessage = transcript.locator(".transcript-event p").first();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre-wrap");

  const wrappedMetrics = await transcript.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(wrappedMetrics.scrollWidth).toBeLessThanOrEqual(wrappedMetrics.clientWidth + 4);

  await toggle.click();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre");

  const nowrapMetrics = await transcript.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(nowrapMetrics.scrollWidth).toBeGreaterThan(nowrapMetrics.clientWidth + 20);
});

test("session detail only shows active task navigation when the session still owns the task", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-linked",
          projectId: "orchestra",
          number: "ORC-101",
          title: "Linked implementation task",
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
            id: "assignment-linked",
            taskId: "task-linked",
            workflowId: "workflow-dev",
            laneId: "lane-implementation",
            workerType: "role",
            workerId: "developer",
            status: "active",
            sessionId: "session-linked",
            runtimeCwd: "/tmp/orchestra/task-linked",
            roleQueueEntryId: null,
            roleInstanceId: null,
            prompt: "Implement the linked task.",
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
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-linked",
          title: "Linked session runtime",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [{ id: "event-linked", kind: "assistant", message: "Working on the linked task.", timestamp }],
          taskId: "task-linked",
          taskNumber: "ORC-101",
          taskTitle: "Linked implementation task",
          activeTaskId: "task-linked",
          activeTaskNumber: "ORC-101",
          activeTaskTitle: "Linked implementation task",
          workerType: "role",
          workerName: "Developer",
        },
        {
          id: "session-stale",
          title: "Former task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [{ id: "event-stale", kind: "assistant", message: "Previously linked to a task.", timestamp }],
          taskId: "task-former",
          taskNumber: "ORC-102",
          taskTitle: "Former linked task",
          workerType: "role",
          workerName: "Developer",
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: /Linked implementation task/ }).click();
  await expect(page.locator('[data-role="session-open-task"]')).toBeVisible();
  await page.locator('[data-role="session-open-task"]').click();
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Linked implementation task");

  await page.getByRole("button", { name: "Sessions" }).click();
  await page.getByRole("link", { name: /Former linked task/ }).click();
  await expect(page.locator('[data-role="session-open-task"]')).toHaveCount(0);
});

test("sessions transcript exposes an auto-scroll toggle that pauses and resumes following live updates", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `event-${index}`,
      kind: index % 2 === 0 ? "assistant" : "user",
      message: `Transcript event ${index}`,
      timestamp,
    }));

    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-auto-scroll-toggle",
          title: "Auto-scroll toggle",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Auto-scroll toggle" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await transcript.waitFor();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "on");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "off");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "false");

  const baselineRefreshCount = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number };
    };
    return testWindow.__orchestraTestSessionRefreshStats ? testWindow.__orchestraTestSessionRefreshStats().listRefreshCount : 0;
  });

  await page.evaluate(() => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== "session-auto-scroll-toggle") {
        return session;
      }
      return {
        ...session,
        updatedAt: new Date().toISOString(),
        events: [
          ...session.events,
          {
            id: "event-new",
            kind: "assistant",
            message: "Newest transcript event",
            timestamp: new Date().toISOString(),
          },
        ],
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: ["session-auto-scroll-toggle"],
        reason: "test.auto_scroll_toggle",
      },
    }));
  });

  await expect.poll(async () => {
    return page.evaluate(() => {
      const testWindow = window as typeof window & {
        __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number };
      };
      return testWindow.__orchestraTestSessionRefreshStats ? testWindow.__orchestraTestSessionRefreshStats().listRefreshCount : 0;
    });
  }).toBe(baselineRefreshCount + 1);

  await expect(transcript).toContainText("Newest transcript event");
  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight < metrics.scrollHeight - 24;
    })
  ).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "on");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "true");
  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);
});

test("sessions entry opens at latest message, resets auto-scroll on re-entry, and follows new events", async ({ page }) => {
  const sessionId = "session-entry-scroll-reset";
  const timestamp = new Date().toISOString();
  const seededSession = {
    id: sessionId,
    title: "Entry scroll reset",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: false,
    events: buildMockSessionEvents(80, "Entry reset event"),
  };

  await page.addInitScript(({ nextSession }) => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([nextSession]));
  }, { nextSession: seededSession });

  await page.goto("/");
  await page.getByRole("link", { name: "Entry scroll reset" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Entry scroll reset");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event immediately after opening", "test.sessions_entry_live_after_open");
  await expect(transcript).toContainText("Newest event immediately after opening");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await scrollTranscriptUp(transcript);
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "off");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "false");
  await expectTranscriptNotAtBottom(transcript);

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await page.getByRole("button", { name: "Sessions" }).click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Entry scroll reset");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event immediately after returning", "test.sessions_entry_live_after_return");
  await expect(transcript).toContainText("Newest event immediately after returning");
  await expectTranscriptAutoScrollOn(transcript, toggle);
});

test("sessions route restoration opens at the latest message with auto-scroll enabled", async ({ page }) => {
  const sessionId = "session-entry-route-restore";
  const timestamp = new Date().toISOString();
  const seededSession = {
    id: sessionId,
    title: "Route restored session",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: false,
    events: buildMockSessionEvents(80, "Route restore event"),
  };

  await page.addInitScript(({ nextSession }) => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([nextSession]));
  }, { nextSession: seededSession });

  await page.goto(`/?page=sessions&selectedSessionId=${sessionId}`);

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", sessionId);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Route restored session");
  await expectTranscriptAutoScrollOn(transcript, toggle);

  await appendMockSessionEvent(page, sessionId, "Newest event after restored entry", "test.sessions_entry_live_after_restore");
  await expect(transcript).toContainText("Newest event after restored entry");
  await expectTranscriptAutoScrollOn(transcript, toggle);
});

test("sessions transcript unlocks on manual scroll and relocks at bottom", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `event-${index}`,
      kind: index % 2 === 0 ? "assistant" : "user",
      message: `Transcript event ${index}`,
      timestamp,
    }));

    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-scroll-lock",
          title: "Scroll lock",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Scroll lock" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');

  await transcript.waitFor();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Scroll lock");

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.scrollHeight > metrics.clientHeight && metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);

  await transcript.evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 160);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight < metrics.scrollHeight - 24;
    })
  ).toBe(true);

  await transcript.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);
});

test("ctrl+t opens a persistent supervisor quick chat modal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-send-message"]')).not.toContainText("Send");
  await expect(page.locator('[data-role="supervisor-send-message"]')).toBeEnabled();

  await page.locator('[data-role="supervisor-composer-input"]').fill("Check the current project status");
  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Check the current project status", { timeout: 10_000 });
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status", { timeout: 20_000 });

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toHaveCount(0);

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status");
});

test("quick supervisor chat keeps the same session and draft during a refresh miss outside the sessions pages", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();

  await page.locator('[data-role="supervisor-composer-input"]').fill("Quick chat message that should stay visible");
  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Quick chat message that should stay visible", { timeout: 20_000 });

  await page.locator('[data-role="supervisor-composer-input"]').fill("Unsent quick chat draft");
  const storedBeforeMiss = await readStoredSupervisorQuickChat(page);
  expect(storedBeforeMiss?.sessionId).toBeTruthy();

  const baselineRefreshCount = await readSessionRefreshCount(page);

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = Date.now();
    Date.now = () => testWindow.__orchestraTestNow ?? 0;
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.dispatchEvent(new Event("focus"));
  });

  await expect.poll(() => readSessionRefreshCount(page)).toBe(baselineRefreshCount + 1);
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Quick chat message that should stay visible");
  await expect(page.locator('[data-role="supervisor-composer-input"]')).toHaveValue("Unsent quick chat draft");

  const storedAfterMiss = await readStoredSupervisorQuickChat(page);
  expect(storedAfterMiss?.sessionId).toBe(storedBeforeMiss?.sessionId ?? null);
  expect(storedAfterMiss?.draft).toBe("Unsent quick chat draft");
});

test("quick supervisor chat reopens the same stored session and draft after reload", async ({ page }) => {
  await page.addInitScript(() => {
    const marker = "orchestra.test.quick-supervisor-reload-initialized";
    if (!window.sessionStorage.getItem(marker)) {
      window.localStorage.clear();
      window.sessionStorage.setItem(marker, "1");
    }
    window.localStorage.setItem("orchestra.mock.active-project-id", "orchestra");
  });

  await page.goto("/");
  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();

  await page.locator('[data-role="supervisor-composer-input"]').fill("Reload should preserve this transcript");
  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Reload should preserve this transcript", { timeout: 20_000 });

  await expect.poll(async () => {
    const sessions = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]"));
    return sessions.some((session: { events?: Array<{ message?: string }> }) =>
      session.events?.some((event) => event.message?.includes("Acknowledged: Reload should preserve this transcript"))
    );
  }).toBe(true);

  await page.locator('[data-role="supervisor-composer-input"]').fill("Draft that should come back after reload");
  const storedBeforeReload = await readStoredSupervisorQuickChat(page);
  expect(storedBeforeReload?.sessionId).toBeTruthy();

  await page.reload();
  const storedAfterPageReload = await readStoredSupervisorQuickChat(page);
  expect(storedAfterPageReload?.sessionId).toBe(storedBeforeReload?.sessionId ?? null);
  expect(storedAfterPageReload?.draft).toBe("Draft that should come back after reload");

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Reload should preserve this transcript");
  await expect(page.locator('[data-role="supervisor-composer-input"]')).toHaveValue("Draft that should come back after reload");

  const storedAfterReload = await readStoredSupervisorQuickChat(page);
  expect(storedAfterReload?.sessionId).toBe(storedBeforeReload?.sessionId ?? null);
  expect(storedAfterReload?.draft).toBe("Draft that should come back after reload");
});

test("quick supervisor chat recovers a stored hidden session via getSessionRecord", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.active-project-id", "orchestra");
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-hidden-supervisor",
          title: "Recovered hidden supervisor session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-hidden-1",
              kind: "assistant",
              message: "Recovered hidden supervisor transcript.",
              timestamp,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.dismissed-sessions.orchestra", JSON.stringify(["session-hidden-supervisor"]));
    window.localStorage.setItem(
      "orchestra.quick-chat.supervisor.orchestra",
      JSON.stringify({ sessionId: "session-hidden-supervisor", draft: "Recovered hidden draft" }),
    );
  });

  await page.goto("/");
  const storedBeforeOpen = await readStoredSupervisorQuickChat(page);
  expect(storedBeforeOpen?.sessionId).toBe("session-hidden-supervisor");
  expect(storedBeforeOpen?.draft).toBe("Recovered hidden draft");

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Recovered hidden supervisor transcript.");
  await expect(page.locator('[data-role="supervisor-composer-input"]')).toHaveValue("Recovered hidden draft");
  await expect(page.locator('[data-role="supervisor-send-message"]')).toBeEnabled();

  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Recovered hidden draft", { timeout: 20_000 });

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && entry.message?.includes("session-hidden-supervisor")).length;
  }).toBeGreaterThan(0);

  const storedQuickChat = await readStoredSupervisorQuickChat(page);
  expect(storedQuickChat?.sessionId).toBe("session-hidden-supervisor");
  expect(storedQuickChat?.draft ?? "").toBe("");
});

test("quick supervisor chat falls back to a fresh supervisor session when the stored session is gone", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.active-project-id", "orchestra");
    window.localStorage.setItem(
      "orchestra.quick-chat.supervisor.orchestra",
      JSON.stringify({ sessionId: "session-missing-supervisor", draft: "Draft that should survive fallback" }),
    );
  });

  await page.goto("/");
  const storedBeforeOpen = await readStoredSupervisorQuickChat(page);
  expect(storedBeforeOpen?.sessionId).toBe("session-missing-supervisor");
  expect(storedBeforeOpen?.draft).toBe("Draft that should survive fallback");

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-composer-input"]')).toHaveValue("Draft that should survive fallback");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toContainText("Supervisor main session");

  const storedQuickChat = await readStoredSupervisorQuickChat(page);
  expect(storedQuickChat?.sessionId).toBeTruthy();
  expect(storedQuickChat?.sessionId).not.toBe("session-missing-supervisor");
  expect(storedQuickChat?.draft).toBe("Draft that should survive fallback");

  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Draft that should survive fallback", { timeout: 20_000 });
});
