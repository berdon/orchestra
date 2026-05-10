import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForEnabledSelector,
  waitForSelector,
  waitForText,
} from "./driver";
import { createRoleViaSettings } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue)}`);
}

async function readAssistantTranscriptState(sessionId: string) {
  return executeScript<{
    assistantCount: number;
    pendingAssistantCount: number;
    lastAssistantMessage: string;
    stuckPlaceholderCount: number;
  }>(sessionId, `
    const assistantEvents = Array.from(document.querySelectorAll('[data-role="transcript-event"][data-event-kind="assistant"]'));
    const getMessage = (event) => {
      const rendered = event.querySelector('[data-role="transcript-entry-rendered-markdown"]')?.textContent?.trim() || '';
      const preview = event.querySelector('[data-role="transcript-entry-preview"]')?.textContent?.trim() || '';
      const code = event.querySelector('[data-role="transcript-entry-code"]')?.textContent?.trim() || '';
      return rendered || preview || code;
    };
    return {
      assistantCount: assistantEvents.length,
      pendingAssistantCount: assistantEvents.filter((event) => Boolean(event.querySelector('.pending-badge'))).length,
      lastAssistantMessage: assistantEvents.length > 0 ? getMessage(assistantEvents[assistantEvents.length - 1]) : '',
      stuckPlaceholderCount: assistantEvents.filter((event) => !event.querySelector('.pending-badge') && getMessage(event) === '…').length,
    };
  `);
}

async function readComposerState(sessionId: string) {
  return executeScript<{
    composerDisabled: boolean;
    sendDisabled: boolean;
    messageabilityClosed: boolean;
    terminalReadonly: boolean;
    piSetupRequired: boolean;
  }>(sessionId, `
    const composer = document.querySelector('[data-role="composer-input"]');
    const send = document.querySelector('[data-role="send-message"]');
    return {
      composerDisabled: composer instanceof HTMLTextAreaElement ? composer.disabled : true,
      sendDisabled: send instanceof HTMLButtonElement ? send.disabled : true,
      messageabilityClosed: Boolean(document.querySelector('[data-role="session-messageability-closed"]')),
      terminalReadonly: Boolean(document.querySelector('[data-role="session-terminal-readonly"]')),
      piSetupRequired: Boolean(document.querySelector('[data-role="session-pi-setup-required"]')),
    };
  `);
}

type SessionRecordLike = {
  id: string;
  status?: string;
  messageability?: "messageable" | "closed" | null;
  events?: Array<{ message?: string | null }>;
};

describe("desktop agent chat navigation", () => {
  it.skipIf(!isDesktopE2E)("opens focused agent chat from Chat nav and keeps Sessions available for debugging", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await createRoleViaSettings(sessionId, {
        name: "Reviewer",
        capacity: "1",
        description: "Role used to verify chat nav excludes workforce roles.",
      });

      await clickByText(sessionId, "button", "Chat");
      await waitForSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');

      const chatNavState = await executeScript<{ labels: string[] }>(sessionId, `
        const items = Array.from(document.querySelectorAll('.settings-subnav[aria-label="Chat agents"] .settings-subnav__item'));
        return {
          labels: items.map((entry) => (entry.textContent || '').trim()).filter(Boolean),
        };
      `);
      expect(chatNavState.labels).toContain('Supervisor');
      expect(chatNavState.labels).not.toContain('Reviewer');

      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');
      await waitForSelector(sessionId, '[data-role="session-wrap-toggle"]');
      await waitForSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      await waitForSelector(sessionId, '[data-role="composer-input"]');
      await waitForCondition(
        () => executeScript<boolean>(sessionId, `
          return Boolean(document.querySelector('[data-role="session-context-stats"]'));
        `),
        (value) => value === true,
      );

      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="session-link"]'));
      `)).toBe(false);
      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="session-filter-active"]'));
      `)).toBe(false);
      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('select[aria-label="Session model"]'));
      `)).toBe(true);
      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="session-context-stats"]'));
      `)).toBe(true);
      expect((await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-context-percent"]')?.textContent || '';
      `)).toLowerCase()).toContain('context');
      expect(await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '';
      `)).toBe('on');
      expect(await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '';
      `)).toBe('true');
      await waitForEnabledSelector(sessionId, '[data-role="composer-input"]');
      const initialComposerState = await readComposerState(sessionId);
      expect(initialComposerState.composerDisabled).toBe(false);
      expect(initialComposerState.sendDisabled).toBe(false);
      expect(initialComposerState.messageabilityClosed).toBe(false);
      expect(initialComposerState.terminalReadonly).toBe(false);
      expect(initialComposerState.piSetupRequired).toBe(false);

      const initialSupervisorMessage = `DESKTOP-SUPERVISOR-ENABLED-${Date.now()}`;
      await setInputValue(sessionId, '[data-role="composer-input"]', initialSupervisorMessage);
      await waitForEnabledSelector(sessionId, '[data-role="send-message"]');
      await clickSelector(sessionId, '[data-role="send-message"]');
      await waitForText(sessionId, initialSupervisorMessage);
      await waitForCondition(
        () => executeScript<boolean>(sessionId, `
          const stop = document.querySelector('[data-role="stop-session-runtime"]');
          return stop instanceof HTMLButtonElement ? stop.disabled : false;
        `),
        (value) => value === true,
        90_000,
      );

      await clickSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      const pausedAutoScroll = await executeScript<{ autoScrollMode: string; scrollLocked: string }>(sessionId, `
        return {
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(pausedAutoScroll.autoScrollMode).toBe('off');
      expect(pausedAutoScroll.scrollLocked).toBe('false');

      await clickSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      const resumedAutoScroll = await executeScript<{ autoScrollMode: string; scrollLocked: string }>(sessionId, `
        return {
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(resumedAutoScroll.autoScrollMode).toBe('on');
      expect(resumedAutoScroll.scrollLocked).toBe('true');

      const firstChatSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `);
      expect(firstChatSessionId).toBeTruthy();

      await clickSelector(sessionId, '[data-role="session-actions-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-actions-menu"]');
      await waitForSelector(sessionId, '[data-role="session-action-new"]');
      expect(await executeScript<boolean>(sessionId, `
        const button = document.querySelector('[data-role="session-action-new"]');
        return button instanceof HTMLButtonElement ? button.disabled : true;
      `)).toBe(false);
      await clickSelector(sessionId, '[data-role="session-action-new"]');
      await waitForText(sessionId, 'Supervisor chat');

      const secondChatSessionId = await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
        `),
        (value) => Boolean(value) && value !== firstChatSessionId,
      );
      expect(secondChatSessionId).toBeTruthy();
      expect(secondChatSessionId).not.toBe(firstChatSessionId);

      await clickSelector(sessionId, '[data-role="session-actions-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-actions-menu"]');
      await waitForSelector(sessionId, '[data-role="session-action-reload"]');
      expect(await executeScript<boolean>(sessionId, `
        const button = document.querySelector('[data-role="session-action-reload"]');
        return button instanceof HTMLButtonElement ? button.disabled : true;
      `)).toBe(false);
      await clickSelector(sessionId, '[data-role="session-action-reload"]');
      await waitForText(sessionId, 'Reloaded');

      const longLine = `DESKTOP-CHAT-${'z'.repeat(240)}`;
      const baselineAssistantState = await readAssistantTranscriptState(sessionId);
      await setInputValue(sessionId, '[data-role="composer-input"]', longLine);
      await waitForEnabledSelector(sessionId, '[data-role="send-message"]');
      await clickSelector(sessionId, '[data-role="send-message"]');
      await waitForText(sessionId, longLine);

      const pendingAssistantState = await waitForCondition(
        () => readAssistantTranscriptState(sessionId),
        (value) => value.assistantCount > baselineAssistantState.assistantCount && value.pendingAssistantCount > 0,
        90_000,
      );
      expect(pendingAssistantState.pendingAssistantCount).toBeGreaterThan(0);

      const resolvedAssistantState = await waitForCondition(
        () => readAssistantTranscriptState(sessionId),
        (value) => (
          value.assistantCount > baselineAssistantState.assistantCount
          && value.pendingAssistantCount === 0
          && Boolean(value.lastAssistantMessage)
          && value.lastAssistantMessage !== '…'
          && value.stuckPlaceholderCount === 0
        ),
        90_000,
      );
      expect(resolvedAssistantState.lastAssistantMessage).not.toBe('…');
      expect(resolvedAssistantState.stuckPlaceholderCount).toBe(0);

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');
      await waitForText(sessionId, 'Supervisor main session');

      const firstSessionCount = await executeScript<number>(sessionId, `
        return Array.from(document.querySelectorAll('[data-role="session-link"]'))
          .filter((entry) => (entry.textContent || '').includes('Supervisor main session')).length;
      `);
      expect(firstSessionCount).toBe(2);

      const selectedSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('.session-list-link--active[data-role="session-link"]')?.getAttribute('data-session-id') || '';
      `);
      expect(selectedSessionId).toBeTruthy();

      await clickByText(sessionId, 'button', 'Chat');
      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');

      const restoredChatSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `);
      expect(restoredChatSessionId).toBe(secondChatSessionId);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("keeps direct agent chats messageable after stopping an in-flight run", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Chat");
      await waitForSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');
      await waitForEnabledSelector(sessionId, '[data-role="composer-input"]');

      const activeAgentSessionId = await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
        `),
        (value) => Boolean(value),
        45_000,
      );

      const runToken = Date.now().toString(36);
      const stoppablePrompt = [
        'Use the bash tool exactly once and wait for it to finish.',
        'Run exactly this command:',
        `\`\`\`bash\nsleep 8 && printf "agent-stop-${runToken}"\n\`\`\``,
        `After the tool completes, reply with exactly agent-stop-${runToken}.`,
      ].join('\n\n');

      await setInputValue(sessionId, '[data-role="composer-input"]', stoppablePrompt);
      await waitForEnabledSelector(sessionId, '[data-role="send-message"]');
      await clickSelector(sessionId, '[data-role="send-message"]');
      await waitForText(sessionId, 'Use the bash tool exactly once');

      await waitForCondition(
        () => executeScript<{ disabled: boolean }>(sessionId, `
          const button = document.querySelector('[data-role="stop-session-runtime"]');
          return { disabled: !(button instanceof HTMLButtonElement) || button.disabled };
        `),
        (value) => value.disabled === false,
        30_000,
      );

      await clickSelector(sessionId, '[data-role="stop-session-runtime"]');

      const stoppedRecord = await waitForCondition(
        () => invokeCommand<SessionRecordLike>(sessionId, 'get_session_record', { sessionId: activeAgentSessionId }),
        (record) => record.status === 'paused' && record.messageability === 'messageable',
        60_000,
      );
      expect(stoppedRecord.status).toBe('paused');
      expect(stoppedRecord.messageability).toBe('messageable');

      const composerState = await waitForCondition(
        () => readComposerState(sessionId),
        (state) => state.composerDisabled === false
          && state.sendDisabled === false
          && state.messageabilityClosed === false
          && state.terminalReadonly === false,
        30_000,
      );
      expect(composerState.messageabilityClosed).toBe(false);
      expect(composerState.terminalReadonly).toBe(false);

      expect(await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `)).toBe(activeAgentSessionId);

      const stoppedUi = await waitForCondition(
        async () => ({
          record: await invokeCommand<SessionRecordLike>(sessionId, 'get_session_record', { sessionId: activeAgentSessionId }),
          transcript: await executeScript<string>(sessionId, `
            return document.querySelector('[data-role="session-transcript"]')?.textContent || '';
          `),
        }),
        ({ record, transcript }) =>
          (record.events ?? []).some((event) =>
            (event.message ?? '').includes('Session run stopped by operator.'),
          ) && transcript.includes('Session run stopped by operator.'),
        60_000,
      );
      expect(stoppedUi.transcript).toContain('Session run stopped by operator.');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
