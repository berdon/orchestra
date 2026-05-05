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
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

type SessionEventRecord = {
  id?: string;
  kind?: string;
  message?: string | null;
  timestamp?: string;
};

type SessionControlOperationRecord = {
  kind?: string;
  trigger?: string;
  status?: string;
  message?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
};

type SessionRecordLike = {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  subscribed?: boolean;
  listVisibility?: string | null;
  events?: SessionEventRecord[];
  controlOperation?: SessionControlOperationRecord | null;
};

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 500,
  label = "condition",
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(`${label} not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function getSelectedSessionUiState(webdriverSessionId: string) {
  return executeScript<{
    selectedSessionId: string;
    title: string;
    transcriptText: string;
    sessionListIds: string[];
  }>(
    webdriverSessionId,
    `
      return {
        selectedSessionId: document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '',
        title: document.querySelector('[data-role="selected-session-title"]')?.textContent?.trim() || '',
        transcriptText: document.querySelector('[data-role="session-transcript"]')?.textContent || '',
        sessionListIds: Array.from(document.querySelectorAll('[data-role="session-link"]')).map((entry) => entry.getAttribute('data-session-id') || '').filter(Boolean),
      };
    `,
  );
}

async function getSessionDiagnostics(webdriverSessionId: string, targetSessionId?: string | null) {
  const ui = await getSelectedSessionUiState(webdriverSessionId).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const record = targetSessionId
    ? await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: targetSessionId }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;
  const sessions = await invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions").catch((error) => ([{
    id: "list_sessions_error",
    title: error instanceof Error ? error.message : String(error),
  }]));
  const logs = await invokeCommand<Array<{ level?: string; target?: string; message?: string }>>(webdriverSessionId, "get_logs").catch((error) => ([{
    level: "error",
    target: "get_logs",
    message: error instanceof Error ? error.message : String(error),
  }]));

  return {
    ui,
    targetSessionId: targetSessionId ?? null,
    record,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      subscribed: session.subscribed,
      controlOperation: session.controlOperation ?? null,
      recentEvents: (session.events ?? []).slice(-5).map((event) => ({
        id: event.id,
        kind: event.kind,
        message: event.message,
      })),
    })),
    recentLogs: logs.slice(0, 15),
  };
}

async function waitForConditionWithDiagnostics<T>(
  webdriverSessionId: string,
  targetSessionId: string | null | undefined,
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
  intervalMs = 500,
) {
  try {
    return await waitForCondition(callback, predicate, timeoutMs, intervalMs, label);
  } catch (error) {
    const diagnostics = await getSessionDiagnostics(webdriverSessionId, targetSessionId).catch((diagnosticError) => ({
      error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function clickSessionAction(webdriverSessionId: string, actionSelector: string) {
  await waitForConditionWithDiagnostics(
    webdriverSessionId,
    null,
    () => executeScript<{ enabled: boolean }>(
      webdriverSessionId,
      `
        const trigger = document.querySelector('[data-role="session-actions-trigger"]');
        const existingMenu = document.querySelector('[data-role="session-actions-menu"]');
        if (!existingMenu && trigger instanceof HTMLElement) {
          trigger.click();
        }
        const action = document.querySelector(arguments[0]);
        return {
          enabled: action instanceof HTMLButtonElement && !action.disabled,
        };
      `,
      [actionSelector],
    ),
    (value) => value.enabled,
    `${actionSelector} to become enabled`,
    30_000,
    250,
  );
  await clickSelector(webdriverSessionId, actionSelector);
}

async function waitForPersistedUserMessage(webdriverSessionId: string, sessionId: string, marker: string) {
  return waitForConditionWithDiagnostics(
    webdriverSessionId,
    sessionId,
    () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId }),
    (record) => (record.events ?? []).some((event) => event.kind === "user" && (event.message ?? "").includes(marker)),
    `persisted user message ${marker}`,
    45_000,
  );
}

async function getTranscriptUserMessageCount(webdriverSessionId: string, marker: string) {
  return executeScript<number>(
    webdriverSessionId,
    `
      return Array.from(document.querySelectorAll('[data-role="transcript-event"][data-event-kind="user"]'))
        .filter((node) => (node.textContent || '').includes(arguments[0]))
        .length;
    `,
    [marker],
  );
}

async function waitForSelectedSessionId(
  webdriverSessionId: string,
  predicate: (sessionId: string) => boolean,
  label: string,
  timeoutMs = 60_000,
) {
  const state = await waitForConditionWithDiagnostics(
    webdriverSessionId,
    null,
    () => getSelectedSessionUiState(webdriverSessionId),
    (value) => predicate(value.selectedSessionId),
    label,
    timeoutMs,
  );
  return state.selectedSessionId;
}

describe("desktop session controls", () => {
  it.skipIf(!isDesktopE2E)("drives compact, reload, and new session through the real desktop runtime path with backend assertions", async () => {
    const webdriverSessionId = await createReadyWebdriverSession();

    try {
      await ensureReactReady(webdriverSessionId);
      await waitForSelector(webdriverSessionId, '[data-role="create-session"]');

      const sessionsBeforeCreate = await invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions");

      await clickSelector(webdriverSessionId, '[data-role="create-session"]');
      await waitForText(webdriverSessionId, "Real pi session ready");

      const primarySessionId = await waitForSelectedSessionId(
        webdriverSessionId,
        (value) => Boolean(value) && !sessionsBeforeCreate.some((session) => session.id === value),
        "newly created primary session to become selected",
      );
      expect(primarySessionId).toBeTruthy();

      const initialPrimaryRecord = await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", {
        sessionId: primarySessionId,
      });
      expect((initialPrimaryRecord.events ?? []).some((event) => (event.message ?? "").startsWith("Session compacted"))).toBe(false);
      expect((initialPrimaryRecord.events ?? []).some((event) => (event.message ?? "") === "Session reloaded.")).toBe(false);

      const compactSeedMessage = `Reply with exactly OK-${Date.now().toString(36)} and nothing else.`;
      await setInputValue(webdriverSessionId, '[data-role="composer-input"]', compactSeedMessage);
      await clickSelector(webdriverSessionId, '[data-role="send-message"]');
      await waitForText(webdriverSessionId, compactSeedMessage);
      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        primarySessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: primarySessionId }),
        (record) => record.status === "idle"
          && (record.events ?? []).some((event) => event.kind === "assistant" && Boolean((event.message ?? "").trim())),
        "seeded session turn to finish before manual compaction",
        90_000,
      );

      await clickSessionAction(webdriverSessionId, '[data-role="session-action-compact"]');

      const compactedRecord = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        primarySessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: primarySessionId }),
        (record) => record.controlOperation?.kind === "compact" && record.controlOperation?.status !== "running",
        "manual compaction control operation to settle",
        45_000,
      );
      if (compactedRecord.controlOperation?.status !== "succeeded") {
        throw new Error(`Compaction did not succeed. ${JSON.stringify(await getSessionDiagnostics(webdriverSessionId, primarySessionId), null, 2)}`);
      }
      expect(compactedRecord.controlOperation?.trigger).toBe("manual");
      expect(compactedRecord.controlOperation?.message).toBe("Session compacted.");
      await waitForText(webdriverSessionId, "Compacted");
      const compactedEvent = (compactedRecord.events ?? []).find((event) => event.kind === "system" && (event.message ?? "").startsWith("Session compacted"));
      if (!compactedEvent?.message) {
        throw new Error(`Compaction record did not include a durable compaction event. ${JSON.stringify(await getSessionDiagnostics(webdriverSessionId, primarySessionId), null, 2)}`);
      }
      expect(compactedEvent.message).toContain("Session compacted");

      await clickByText(webdriverSessionId, "button", "Chat");
      await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
      await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(webdriverSessionId, "Supervisor chat");

      const firstChatSessionId = await waitForSelectedSessionId(
        webdriverSessionId,
        (value) => Boolean(value) && value !== primarySessionId,
        "supervisor chat session to become selected",
      );
      expect(firstChatSessionId).toBeTruthy();

      const sessionsBeforeNewAction = await invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions");
      await clickSessionAction(webdriverSessionId, '[data-role="session-action-new"]');
      await waitForText(webdriverSessionId, "Supervisor chat");

      const successorSessionId = await waitForSelectedSessionId(
        webdriverSessionId,
        (value) => Boolean(value) && value !== firstChatSessionId,
        "successor chat session to replace the selected session after New session",
      );
      expect(successorSessionId).toBeTruthy();
      expect(successorSessionId).not.toBe(firstChatSessionId);

      const sessionsAfterNewAction = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        successorSessionId,
        () => invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions"),
        (sessions) => !sessions.some((session) => session.id === firstChatSessionId)
          && sessions.some((session) => session.id === successorSessionId),
        "new session action to replace the previous chat session in normal lists",
        45_000,
      );
      expect(sessionsAfterNewAction.some((session) => session.id === firstChatSessionId)).toBe(false);
      expect(sessionsAfterNewAction.some((session) => session.id === successorSessionId)).toBe(true);

      const supersededRecord = await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", {
        sessionId: firstChatSessionId,
      });
      expect(supersededRecord.id).toBe(firstChatSessionId);
      expect(supersededRecord.status).toBe("closed");
      expect(supersededRecord.listVisibility).toBe("hidden");

      await clickSessionAction(webdriverSessionId, '[data-role="session-action-reload"]');

      const reloadedRecord = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        successorSessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: successorSessionId }),
        (record) => record.controlOperation?.kind === "reload" && record.controlOperation?.status !== "running",
        "manual reload control operation to settle for the chat successor session",
        45_000,
      );
      if (reloadedRecord.controlOperation?.status !== "succeeded") {
        throw new Error(`Reload did not succeed. ${JSON.stringify(await getSessionDiagnostics(webdriverSessionId, successorSessionId), null, 2)}`);
      }
      expect(reloadedRecord.id).toBe(successorSessionId);
      expect(reloadedRecord.controlOperation?.trigger).toBe("manual");
      expect(reloadedRecord.controlOperation?.message).toBe("Session reloaded.");
      await waitForText(webdriverSessionId, "Reloaded");
      expect(await waitForSelectedSessionId(webdriverSessionId, (value) => value === successorSessionId, "same chat session to remain selected after reload", 15_000)).toBe(successorSessionId);

      const successorRecord = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        successorSessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: successorSessionId }),
        (record) => (record.events ?? []).some((event) => (event.message ?? "").includes("Real pi session ready")),
        "newly created successor chat session to keep its initial transcript after reload",
        45_000,
      );
      expect(successorRecord.id).toBe(successorSessionId);
      expect((successorRecord.events ?? []).some((event) => (event.message ?? "").startsWith("Session compacted"))).toBe(false);

      const finalUiState = await getSelectedSessionUiState(webdriverSessionId);
      expect(finalUiState.selectedSessionId).toBe(successorSessionId);
      expect(finalUiState.transcriptText).toContain("Real pi session ready");
    } finally {
      await deleteWebdriverSession(webdriverSessionId);
    }
  }, 240_000);

  it.skipIf(!isDesktopE2E)("does not duplicate a follow-up user message while the session is already streaming", async () => {
    const webdriverSessionId = await createReadyWebdriverSession();

    try {
      await ensureReactReady(webdriverSessionId);
      await waitForSelector(webdriverSessionId, '[data-role="create-session"]');

      const sessionsBeforeCreate = await invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions");
      await clickSelector(webdriverSessionId, '[data-role="create-session"]');
      await waitForText(webdriverSessionId, "Real pi session ready");

      const sessionId = await waitForSelectedSessionId(
        webdriverSessionId,
        (value) => Boolean(value) && !sessionsBeforeCreate.some((session) => session.id === value),
        "newly created session to become selected for the streaming follow-up regression",
      );

      const runToken = Date.now().toString(36);
      const firstMessage = [
        "Use the bash tool before answering.",
        "Run exactly this command and wait for it to finish:",
        "```bash\nsleep 8 && printf 'tool-finished-" + runToken + "'\n```",
        `After the tool completes, reply with exactly tool-finished-${runToken}.`,
      ].join("\n\n");
      const followUpMessage = `Streaming follow-up ${runToken} should appear once.`;

      await setInputValue(webdriverSessionId, '[data-role="composer-input"]', firstMessage);
      await clickSelector(webdriverSessionId, '[data-role="send-message"]');
      await waitForText(webdriverSessionId, "Use the bash tool before answering.");
      await sleep(1_500);

      await setInputValue(webdriverSessionId, '[data-role="composer-input"]', followUpMessage);
      await clickSelector(webdriverSessionId, '[data-role="send-message"]');

      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        sessionId,
        () => getTranscriptUserMessageCount(webdriverSessionId, followUpMessage),
        (count) => count >= 1,
        "follow-up user message to appear in the transcript while the earlier run is still streaming",
        20_000,
        250,
      );
      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        sessionId,
        () => invokeCommand<Array<{ target?: string; message?: string }>>(webdriverSessionId, "get_logs"),
        (logs) => logs.some((entry) => entry.target === "sessions.message.follow_up" && (entry.message ?? "").includes(sessionId)),
        "backend to queue the second message as a follow_up while the first run is still active",
        45_000,
        250,
      );

      for (let sample = 0; sample < 5; sample += 1) {
        expect(await getTranscriptUserMessageCount(webdriverSessionId, followUpMessage)).toBe(1);
        const record = await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId });
        if (record.status !== "streaming") {
          break;
        }
        await sleep(750);
      }

      const persistedFollowUp = await waitForPersistedUserMessage(webdriverSessionId, sessionId, followUpMessage);
      expect((persistedFollowUp.events ?? []).filter((event) => event.kind === "user" && (event.message ?? "").includes(followUpMessage))).toHaveLength(1);

      const settledRecord = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        sessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId }),
        (record) => record.status === "idle"
          && (record.events ?? []).filter((event) => event.kind === "user" && (event.message ?? "").includes(followUpMessage)).length === 1,
        "streaming follow-up scenario to settle with exactly one persisted follow-up user message",
        120_000,
      );

      expect((settledRecord.events ?? []).filter((event) => event.kind === "user" && (event.message ?? "").includes(followUpMessage))).toHaveLength(1);
      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        sessionId,
        () => getTranscriptUserMessageCount(webdriverSessionId, followUpMessage),
        (count) => count === 1,
        "transcript to converge back to exactly one follow-up user row after the run settles",
        15_000,
        250,
      );
    } finally {
      await deleteWebdriverSession(webdriverSessionId);
    }
  }, 240_000);
});
