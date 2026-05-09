import { describe, expect, it } from "vitest";

import {
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
const hasManagedRealModel =
  process.env.ORCHESTRA_DESKTOP_E2E_MANAGED_PI_READY === "1";

type TranscriptRow = {
  eventId: string;
  kind: string;
  runId: string;
  pending: boolean;
  thinking: boolean;
  text: string;
};

type TranscriptSnapshot = {
  selectedSessionId: string;
  sessionListIds: string[];
  rows: TranscriptRow[];
  pendingCount: number;
  transcriptText: string;
};

type SessionEventRecord = {
  id?: string;
  kind?: string;
  message?: string | null;
  timestamp?: string;
  runId?: string | null;
};

type SessionRecordLike = {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  subscribed?: boolean;
  events?: SessionEventRecord[];
};

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 90_000,
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

  throw new Error(
    `${label} not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`,
  );
}

async function getTranscriptSnapshot(webdriverSessionId: string) {
  return executeScript<TranscriptSnapshot>(
    webdriverSessionId,
    `
      const panel = document.querySelector('[data-role="session-chat-panel"]');
      const transcript = panel?.querySelector('[data-role="session-transcript"]') || document.querySelector('[data-role="session-transcript"]');
      const rows = Array.from(transcript?.querySelectorAll('[data-role="transcript-event"]') || []).map((node) => {
        const content = node.querySelector('[data-role="transcript-entry-rendered-markdown"], [data-role="transcript-entry-preview"], [data-role="transcript-entry-code"], [data-role="transcript-thinking-preview"]');
        const fallback = node.querySelector('.transcript-event__body');
        return {
          eventId: node.getAttribute('data-event-id') || '',
          kind: node.getAttribute('data-event-kind') || '',
          runId: node.getAttribute('data-event-run-id') || '',
          pending: node.getAttribute('data-event-pending') === 'true',
          thinking: node.getAttribute('data-event-thinking') === 'true',
          text: (content?.textContent || fallback?.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      });
      return {
        selectedSessionId: panel?.getAttribute('data-session-id') || '',
        sessionListIds: Array.from(document.querySelectorAll('[data-role="session-link"]')).map((entry) => entry.getAttribute('data-session-id') || '').filter(Boolean),
        rows,
        pendingCount: rows.filter((row) => row.pending).length,
        transcriptText: transcript?.textContent?.replace(/\s+/g, ' ').trim() || '',
      };
    `,
  );
}

async function getSessionDiagnostics(
  webdriverSessionId: string,
  targetSessionId: string | null,
) {
  const ui = await getTranscriptSnapshot(webdriverSessionId).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const record = targetSessionId
    ? await invokeCommand<SessionRecordLike>(
        webdriverSessionId,
        "get_session_record",
        { sessionId: targetSessionId },
      ).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;
  const sessions = await invokeCommand<Array<SessionRecordLike>>(
    webdriverSessionId,
    "list_sessions",
  ).catch((error) => [
    {
      id: "list_sessions_error",
      title: error instanceof Error ? error.message : String(error),
    },
  ]);
  const logs = await invokeCommand<
    Array<{ level?: string; target?: string; message?: string }>
  >(webdriverSessionId, "get_logs").catch((error) => [
    {
      level: "error",
      target: "get_logs",
      message: error instanceof Error ? error.message : String(error),
    },
  ]);

  return {
    ui,
    targetSessionId,
    record,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      subscribed: session.subscribed,
      recentEvents: (session.events ?? []).slice(-8).map((event) => ({
        id: event.id,
        kind: event.kind,
        runId: event.runId,
        message: event.message,
      })),
    })),
    recentLogs: logs.slice(0, 20),
  };
}

async function waitForConditionWithDiagnostics<T>(
  webdriverSessionId: string,
  targetSessionId: string | null,
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 90_000,
  intervalMs = 500,
) {
  try {
    return await waitForCondition(
      callback,
      predicate,
      timeoutMs,
      intervalMs,
      label,
    );
  } catch (error) {
    const diagnostics = await getSessionDiagnostics(
      webdriverSessionId,
      targetSessionId,
    ).catch((diagnosticError) => ({
      error:
        diagnosticError instanceof Error
          ? diagnosticError.message
          : String(diagnosticError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`,
    );
  }
}

function userMessageCount(record: SessionRecordLike | null | undefined) {
  return (record?.events ?? []).filter(
    (event) => event.kind === "user" && Boolean((event.message ?? "").trim()),
  ).length;
}

function assistantMessageCount(record: SessionRecordLike | null | undefined) {
  return (record?.events ?? []).filter(
    (event) =>
      event.kind === "assistant" && Boolean((event.message ?? "").trim()),
  ).length;
}

function normalizeComparableText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstIndexContaining(
  rows: Array<{ kind?: string; text?: string | null; message?: string | null }>,
  kind: string,
  needle: string,
  startIndex = 0,
) {
  const normalizedNeedle = normalizeComparableText(needle);
  return rows.findIndex(
    (row, index) =>
      index >= startIndex &&
      row.kind === kind &&
      normalizeComparableText(row.text ?? row.message).includes(
        normalizedNeedle,
      ),
  );
}

function expectUserAssistantOrdering(
  record: SessionRecordLike,
  prompts: string[],
) {
  const rows = (record.events ?? []).map((event) => ({
    kind: event.kind ?? "",
    message: event.message ?? "",
  }));
  let cursor = 0;
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index]!;
    const userIndex = firstIndexContaining(rows, "user", prompt, cursor);
    expect(
      userIndex,
      `expected persisted user message for ${prompt}`,
    ).toBeGreaterThanOrEqual(0);
    const nextUserIndex =
      index + 1 < prompts.length
        ? firstIndexContaining(rows, "user", prompts[index + 1]!, userIndex + 1)
        : -1;
    const assistantWindowEnd = nextUserIndex >= 0 ? nextUserIndex : rows.length;
    const assistantIndex = rows.findIndex(
      (row, rowIndex) =>
        rowIndex > userIndex &&
        rowIndex < assistantWindowEnd &&
        row.kind === "assistant" &&
        Boolean(row.message.trim()),
    );
    expect(
      assistantIndex,
      `expected an assistant reply after ${prompt}`,
    ).toBeGreaterThan(userIndex);
    cursor = userIndex + 1;
  }
}

function expectTranscriptLifecycleOrder(
  snapshot: TranscriptSnapshot,
  expectedKinds: string[],
) {
  const actualKinds = snapshot.rows
    .filter((row) => row.kind === "user" || row.kind === "assistant")
    .map((row) => row.kind);
  expect(actualKinds.slice(-expectedKinds.length)).toEqual(expectedKinds);
}

async function createFreshSession(webdriverSessionId: string) {
  const sessionsBeforeCreate = await invokeCommand<Array<SessionRecordLike>>(
    webdriverSessionId,
    "list_sessions",
  );
  await clickSelector(webdriverSessionId, '[data-role="create-session"]');
  await waitForText(webdriverSessionId, "Real pi session ready", 60_000);
  const snapshot = await waitForConditionWithDiagnostics(
    webdriverSessionId,
    null,
    () => getTranscriptSnapshot(webdriverSessionId),
    (value) =>
      Boolean(value.selectedSessionId) &&
      !sessionsBeforeCreate.some(
        (session) => session.id === value.selectedSessionId,
      ),
    "newly created session to become selected",
    60_000,
  );
  return snapshot.selectedSessionId;
}

async function sendComposerMessage(
  webdriverSessionId: string,
  message: string,
) {
  await setInputValue(
    webdriverSessionId,
    '[data-role="composer-input"]',
    message,
  );
  await clickSelector(webdriverSessionId, '[data-role="send-message"]');
  await waitForText(webdriverSessionId, message, 15_000);
}

async function waitForPendingAssistant(
  webdriverSessionId: string,
  sessionId: string,
) {
  return waitForConditionWithDiagnostics(
    webdriverSessionId,
    sessionId,
    () => getTranscriptSnapshot(webdriverSessionId),
    (snapshot) =>
      snapshot.rows.some((row) => row.kind === "assistant" && row.pending),
    "pending assistant placeholder",
    30_000,
    250,
  );
}

async function waitForSessionSettled(
  webdriverSessionId: string,
  sessionId: string,
  minimumUserMessages: number,
  minimumAssistantMessages: number,
) {
  return waitForConditionWithDiagnostics(
    webdriverSessionId,
    sessionId,
    async () => ({
      snapshot: await getTranscriptSnapshot(webdriverSessionId),
      record: await invokeCommand<SessionRecordLike>(
        webdriverSessionId,
        "get_session_record",
        { sessionId },
      ),
    }),
    ({ snapshot, record }) =>
      record.status === "idle" &&
      snapshot.pendingCount === 0 &&
      userMessageCount(record) >= minimumUserMessages &&
      assistantMessageCount(record) >= minimumAssistantMessages,
    "session to settle with cleared pending state",
    120_000,
  );
}

describe("desktop session message lifecycle", () => {
  it.skipIf(!isDesktopE2E)(
    "resolves a pending assistant placeholder and preserves the same settled transcript after a page reload",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );
        const prompt = `Reply with the exact token ORC270-BASIC-${Date.now().toString(36)} and nothing else.`;

        await sendComposerMessage(webdriverSessionId, prompt);
        await waitForPendingAssistant(webdriverSessionId, sessionId);
        const settled = await waitForSessionSettled(
          webdriverSessionId,
          sessionId,
          userMessageCount(baselineRecord) + 1,
          assistantMessageCount(baselineRecord) + 1,
        );

        expectTranscriptLifecycleOrder(settled.snapshot, ["user", "assistant"]);
        expectUserAssistantOrdering(settled.record, [prompt]);
        const settledSequence = settled.snapshot.rows.map((row) => ({
          kind: row.kind,
          pending: row.pending,
          text: row.text,
        }));

        await executeScript(
          webdriverSessionId,
          "window.location.reload(); return true;",
        );
        await ensureReactReady(webdriverSessionId);
        await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () => getTranscriptSnapshot(webdriverSessionId),
          (snapshot) => snapshot.sessionListIds.includes(sessionId),
          "reloaded app to list the prior session",
          60_000,
        );
        await clickSelector(
          webdriverSessionId,
          `[data-role="session-link"][data-session-id="${sessionId}"]`,
        );
        const reloaded = await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          async () => ({
            snapshot: await getTranscriptSnapshot(webdriverSessionId),
            record: await invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          }),
          ({ snapshot, record }) =>
            snapshot.selectedSessionId === sessionId &&
            record.status === "idle" &&
            snapshot.pendingCount === 0,
          "reloaded transcript to settle without stale pending state",
          60_000,
        );

        expect(
          reloaded.snapshot.rows.map((row) => ({
            kind: row.kind,
            pending: row.pending,
            text: row.text,
          })),
        ).toEqual(settledSequence);
        expectUserAssistantOrdering(reloaded.record, [prompt]);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "keeps multiple sequential sends ordered and settled in both the transcript and backend record",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );
        const prompts = [
          `Reply with the exact token ORC270-SEQ-A-${Date.now().toString(36)} and nothing else.`,
          `Reply with the exact token ORC270-SEQ-B-${(Date.now() + 1).toString(36)} and nothing else.`,
        ];

        for (let index = 0; index < prompts.length; index += 1) {
          await sendComposerMessage(webdriverSessionId, prompts[index]!);
          await waitForSessionSettled(
            webdriverSessionId,
            sessionId,
            userMessageCount(baselineRecord) + index + 1,
            assistantMessageCount(baselineRecord) + index + 1,
          );
        }

        const finalState = await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          async () => ({
            snapshot: await getTranscriptSnapshot(webdriverSessionId),
            record: await invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          }),
          ({ snapshot, record }) =>
            snapshot.pendingCount === 0 && record.status === "idle",
          "sequential send transcript to remain settled",
        );

        expectTranscriptLifecycleOrder(finalState.snapshot, [
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        expectUserAssistantOrdering(finalState.record, prompts);
        expect(finalState.snapshot.rows.some((row) => row.pending)).toBe(false);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E || !hasManagedRealModel)(
    "uses Orchestra-managed real-model config to send a queued second message through one session and get a reply for each turn",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const setupState = await invokeCommand<{
          status?: string;
          authPath?: string;
          modelsPath?: string;
        }>(webdriverSessionId, "get_pi_setup_state");
        expect(setupState.status).toBe("ready");
        expect(setupState.authPath ?? "").toContain(
          "runtime/pi/agent/auth.json",
        );
        expect(setupState.authPath ?? "").not.toContain("/.pi/agent/");
        expect(setupState.modelsPath ?? "").toContain(
          "runtime/pi/agent/models.json",
        );
        expect(setupState.modelsPath ?? "").not.toContain("/.pi/agent/");

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );
        await invokeCommand(webdriverSessionId, "set_session_model", {
          sessionId,
          provider: "openai-codex",
          modelId: "gpt-5.3-codex-spark",
        });

        const runToken = Date.now().toString(36);
        const prompts = [
          `Reply with exactly ORC278-REAL-A-${runToken} and nothing else.`,
          `Reply with exactly ORC278-REAL-B-${runToken} and nothing else.`,
        ];

        await sendComposerMessage(webdriverSessionId, prompts[0]!);
        await waitForPendingAssistant(webdriverSessionId, sessionId);
        await sendComposerMessage(webdriverSessionId, prompts[1]!);

        const settled = await waitForSessionSettled(
          webdriverSessionId,
          sessionId,
          userMessageCount(baselineRecord) + 2,
          assistantMessageCount(baselineRecord) + 2,
        );

        expectTranscriptLifecycleOrder(settled.snapshot, [
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        expectUserAssistantOrdering(settled.record, prompts);
        expect(settled.snapshot.pendingCount).toBe(0);
        for (const token of [
          `ORC278-REAL-A-${runToken}`,
          `ORC278-REAL-B-${runToken}`,
        ]) {
          expect(
            (settled.record.events ?? []).some(
              (event) =>
                event.kind === "assistant" &&
                normalizeComparableText(event.message).includes(token),
            ),
          ).toBe(true);
          expect(
            settled.snapshot.rows.some(
              (row) =>
                row.kind === "assistant" &&
                normalizeComparableText(row.text).includes(token),
            ),
          ).toBe(true);
        }
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "keeps a follow-up send visible while the prior response is still pending and settles both turns without stale pending state",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );
        const prompts = [
          `Respond with the exact token ORC270-FOLLOWUP-A-${Date.now().toString(36)} and nothing else.`,
          `Respond with the exact token ORC270-FOLLOWUP-B-${(Date.now() + 1).toString(36)} and nothing else.`,
        ];

        await sendComposerMessage(webdriverSessionId, prompts[0]!);
        await waitForPendingAssistant(webdriverSessionId, sessionId);
        await sendComposerMessage(webdriverSessionId, prompts[1]!);

        const pendingSnapshot = await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () => getTranscriptSnapshot(webdriverSessionId),
          (snapshot) =>
            snapshot.rows.filter((row) => row.kind === "user").length >= 2,
          "queued follow-up message to stay visible while a prior response is pending",
          30_000,
          250,
        );
        expect(
          pendingSnapshot.rows.filter((row) => row.kind === "user").length,
        ).toBeGreaterThanOrEqual(2);

        const settled = await waitForSessionSettled(
          webdriverSessionId,
          sessionId,
          userMessageCount(baselineRecord) + 2,
          assistantMessageCount(baselineRecord) + 2,
        );

        expectTranscriptLifecycleOrder(settled.snapshot, [
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        expectUserAssistantOrdering(settled.record, prompts);
        expect(settled.snapshot.pendingCount).toBe(0);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "delivers explicit interrupt sends ahead of queued follow-ups after the current turn finishes",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );
        const runToken = Date.now().toString(36);
        const initialToken = `ORC273-BASE-${runToken}`;
        const queuedToken = `ORC273-QUEUE-${runToken}`;
        const interruptToken = `ORC273-INTERRUPT-${runToken}`;
        const firstPrompt = [
          "Use the bash tool exactly once and wait for it to finish before replying.",
          `Run this exact shell command: sh -lc 'sleep 8; printf "${initialToken}"'`,
          "After the command completes, reply with only the printed token.",
        ].join(" ");
        const queuedPrompt = `Reply with exactly ${queuedToken} and nothing else.`;
        const interruptPrompt = `Reply with exactly ${interruptToken} and nothing else.`;

        await sendComposerMessage(webdriverSessionId, firstPrompt);
        await waitForPendingAssistant(webdriverSessionId, sessionId);

        await invokeCommand<{
          sessionId: string;
          runId: string;
          message: string;
        }>(webdriverSessionId, "send_session_message", {
          sessionId,
          message: queuedPrompt,
          runId: `queue-${runToken}`,
          sendMode: "queue",
        });
        await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () =>
            invokeCommand<Array<{ target?: string; message?: string }>>(
              webdriverSessionId,
              "get_logs",
            ),
          (logs) =>
            logs.some(
              (entry) =>
                entry.target === "sessions.message.follow_up" &&
                (entry.message ?? "").includes(sessionId),
            ),
          "explicit queue send to log a follow_up delivery while the session is busy",
          45_000,
          250,
        );

        await invokeCommand<{
          sessionId: string;
          runId: string;
          message: string;
        }>(webdriverSessionId, "send_session_message", {
          sessionId,
          message: interruptPrompt,
          runId: `interrupt-${runToken}`,
          sendMode: "interrupt",
        });
        await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () =>
            invokeCommand<Array<{ target?: string; message?: string }>>(
              webdriverSessionId,
              "get_logs",
            ),
          (logs) =>
            logs.some(
              (entry) =>
                entry.target === "sessions.message.steer" &&
                (entry.message ?? "").includes(sessionId),
            ),
          "explicit interrupt send to log a steer delivery while the session is busy",
          45_000,
          250,
        );

        const settled = await waitForSessionSettled(
          webdriverSessionId,
          sessionId,
          userMessageCount(baselineRecord) + 3,
          assistantMessageCount(baselineRecord) + 2,
        );

        const rows = settled.record.events ?? [];
        const initialUserIndex = rows.findIndex(
          (event) =>
            event.kind === "user" &&
            normalizeComparableText(event.message).includes(initialToken),
        );
        const initialToolResultIndex = rows.findIndex(
          (event) =>
            event.kind === "system" &&
            normalizeComparableText(event.message).includes(initialToken),
        );
        const interruptIndex = rows.findIndex(
          (event) =>
            event.kind === "assistant" &&
            normalizeComparableText(event.message).includes(interruptToken),
        );
        const queuedIndex = rows.findIndex(
          (event) =>
            event.kind === "assistant" &&
            normalizeComparableText(event.message).includes(queuedToken),
        );

        expect(initialUserIndex).toBeGreaterThanOrEqual(0);
        expect(initialToolResultIndex).toBeGreaterThan(initialUserIndex);
        expect(interruptIndex).toBeGreaterThan(initialToolResultIndex);
        expect(queuedIndex).toBeGreaterThan(interruptIndex);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "clears pending message state after stopping an in-flight response",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(
          webdriverSessionId,
          '[data-role="create-session"]',
        );

        const sessionId = await createFreshSession(webdriverSessionId);
        const longPrompt = [
          "Use the bash tool exactly once and wait for it to finish before replying.",
          'Run this exact shell command: sh -lc \'printf "ORC270-STOP-%s\\n" "$(date +%s%N)"; sleep 15\'',
          "After the command completes, reply with only the printed token.",
        ].join(" ");

        await sendComposerMessage(webdriverSessionId, longPrompt);
        await waitForPendingAssistant(webdriverSessionId, sessionId);
        await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () =>
            invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          (record) =>
            (record.events ?? []).some(
              (event) =>
                event.kind === "user" &&
                (event.message ?? "").includes(
                  "Use the bash tool exactly once",
                ),
            ),
          "stoppable prompt to persist its user message before interruption",
          60_000,
          250,
        );
        await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          () =>
            executeScript<{ disabled: boolean }>(
              webdriverSessionId,
              `
          const button = document.querySelector('[data-role="stop-session-runtime"]');
          return { disabled: !(button instanceof HTMLButtonElement) || button.disabled };
        `,
            ),
          (value) => value.disabled === false,
          "stop button to become enabled during tool execution",
          30_000,
          250,
        );

        await clickSelector(
          webdriverSessionId,
          '[data-role="stop-session-runtime"]',
        );

        const stopped = await waitForConditionWithDiagnostics(
          webdriverSessionId,
          sessionId,
          async () => ({
            snapshot: await getTranscriptSnapshot(webdriverSessionId),
            record: await invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          }),
          ({ snapshot, record }) =>
            record.status === "paused" &&
            snapshot.pendingCount === 0 &&
            (record.events ?? []).some((event) =>
              (event.message ?? "").includes(
                "Session run stopped by operator.",
              ),
            ),
          "stopped session to clear pending message state with a durable stop marker",
          60_000,
        );

        expect(stopped.snapshot.rows.some((row) => row.pending)).toBe(false);
        expect(
          stopped.snapshot.rows.some((row) =>
            row.eventId.startsWith("client-stop-"),
          ),
        ).toBe(false);
        expect(
          stopped.record.events?.some((event) =>
            (event.message ?? "").includes("Session run stopped by operator."),
          ),
        ).toBe(true);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    240_000,
  );
});
