import { existsSync, readFileSync } from "node:fs";

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
const fixtureLogPath = process.env.ORCHESTRA_FAKE_PI_STALE_PROMPT_LOG_PATH;

type TranscriptRow = {
  kind: string;
  text: string;
  pending: boolean;
};

type TranscriptSnapshot = {
  selectedSessionId: string;
  rows: TranscriptRow[];
  pendingCount: number;
  transcriptText: string;
  composerDisabled: boolean;
  sendDisabled: boolean;
};

type SessionEventRecord = {
  kind?: string;
  message?: string | null;
};

type SessionRecordLike = {
  id: string;
  status?: string;
  events?: SessionEventRecord[];
};

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
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

function readFixtureLogEntries() {
  if (!fixtureLogPath || !existsSync(fixtureLogPath)) {
    return [] as Array<Record<string, unknown>>;
  }
  return readFileSync(fixtureLogPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
          kind: node.getAttribute('data-event-kind') || '',
          text: (content?.textContent || fallback?.textContent || '').replace(/\s+/g, ' ').trim(),
          pending: node.getAttribute('data-event-pending') === 'true',
        };
      });
      const composer = document.querySelector('[data-role="composer-input"]');
      const send = document.querySelector('[data-role="send-message"]');
      return {
        selectedSessionId: panel?.getAttribute('data-session-id') || '',
        rows,
        pendingCount: rows.filter((row) => row.pending).length,
        transcriptText: transcript?.textContent?.replace(/\s+/g, ' ').trim() || '',
        composerDisabled: composer instanceof HTMLTextAreaElement ? composer.disabled : true,
        sendDisabled: send instanceof HTMLButtonElement ? send.disabled : true,
      };
    `,
  );
}

async function createFreshSession(webdriverSessionId: string) {
  const sessionsBeforeCreate = await invokeCommand<Array<SessionRecordLike>>(
    webdriverSessionId,
    "list_sessions",
  );
  await clickSelector(webdriverSessionId, '[data-role="create-session"]');
  await waitForText(webdriverSessionId, "Real pi session ready", 60_000);
  const snapshot = await waitForCondition(
    () => getTranscriptSnapshot(webdriverSessionId),
    (value) =>
      Boolean(value.selectedSessionId) &&
      !sessionsBeforeCreate.some((session) => session.id === value.selectedSessionId),
    60_000,
    250,
    "newly created session to become selected",
  );
  return snapshot.selectedSessionId;
}

async function sendComposerMessage(webdriverSessionId: string, message: string) {
  await setInputValue(
    webdriverSessionId,
    '[data-role="composer-input"]',
    message,
  );
  await clickSelector(webdriverSessionId, '[data-role="send-message"]');
  await waitForText(webdriverSessionId, message, 15_000);
}

describe("desktop idle session send recovery", () => {
  it.skipIf(!isDesktopE2E)(
    "clears a stale accepted prompt without Stop and lets the next resend succeed",
    async () => {
      expect(fixtureLogPath).toBeTruthy();

      const webdriverSessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(webdriverSessionId);
        await waitForSelector(webdriverSessionId, '[data-role="create-session"]');

        const sessionId = await createFreshSession(webdriverSessionId);
        const baselineRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId },
        );

        const stalePrompt = `Trigger stale idle-session recovery ${Date.now().toString(36)}`;
        await sendComposerMessage(webdriverSessionId, stalePrompt);

        await waitForCondition(
          () => getTranscriptSnapshot(webdriverSessionId),
          (snapshot) => snapshot.pendingCount > 0,
          15_000,
          250,
          "optimistic pending send",
        );

        const recovered = await waitForCondition(
          async () => ({
            snapshot: await getTranscriptSnapshot(webdriverSessionId),
            record: await invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          }),
          ({ snapshot, record }) =>
            snapshot.pendingCount === 0 &&
            record.status === "idle" &&
            snapshot.transcriptText.includes("Send failed") &&
            snapshot.transcriptText.toLowerCase().includes("retry your") &&
            snapshot.composerDisabled === false &&
            snapshot.sendDisabled === false,
          30_000,
          250,
          "stale send recovery",
        );

        expect(userMessageCount(recovered.record)).toBe(
          userMessageCount(baselineRecord),
        );
        expect(assistantMessageCount(recovered.record)).toBe(
          assistantMessageCount(baselineRecord),
        );
        expect(
          recovered.snapshot.rows.some((row) => row.pending),
        ).toBe(false);

        const retryPrompt = `Retry after stale idle-session recovery ${Date.now().toString(36)}`;
        await sendComposerMessage(webdriverSessionId, retryPrompt);

        const settled = await waitForCondition(
          async () => ({
            snapshot: await getTranscriptSnapshot(webdriverSessionId),
            record: await invokeCommand<SessionRecordLike>(
              webdriverSessionId,
              "get_session_record",
              { sessionId },
            ),
          }),
          ({ snapshot, record }) =>
            snapshot.pendingCount === 0 &&
            record.status === "idle" &&
            snapshot.rows.some((row) => row.kind === "assistant") &&
            (record.events ?? []).some(
              (event) => event.kind === "assistant" && event.message === `Fixture recovered reply: ${retryPrompt}`,
            ) &&
            userMessageCount(record) === userMessageCount(baselineRecord) + 1 &&
            assistantMessageCount(record) === assistantMessageCount(baselineRecord) + 1,
          30_000,
          250,
          "retry send to settle successfully",
        );

        expect(
          settled.snapshot.rows.some((row) => row.kind === "assistant"),
        ).toBe(true);
        expect(
          (settled.record.events ?? []).some(
            (event) => event.kind === "assistant" && event.message === `Fixture recovered reply: ${retryPrompt}`,
          ),
        ).toBe(true);

        const fixtureEntries = await waitForCondition(
          async () => readFixtureLogEntries(),
          (entries) =>
            entries.some((entry) => entry.branch === "prompt:stalled") &&
            entries.some((entry) => entry.branch === "prompt:recovered"),
          15_000,
          250,
          "fixture to record both the stalled and recovered sends",
        );
        expect(
          fixtureEntries.filter((entry) => entry.branch === "prompt:stalled"),
        ).toHaveLength(1);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );
});
