import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionStreamEnvelope } from "../src/types";
import {
  applyPendingRunToSession,
  createPendingUserRun,
  reconcilePendingRunsWithSession,
  reduceSessionTranscriptEvent,
} from "../src/lib/sessionTranscriptReducer";

function makeSession(id = "session-1"): SessionRecord {
  return {
    id,
    title: "Test session",
    status: "active",
    createdAt: "2026-04-08T00:00:00Z",
    updatedAt: "2026-04-08T00:00:00Z",
    subscribed: false,
    events: [],
    terminalAttached: false,
    activityState: "idle",
    activeToolName: null,
    lastActivityAt: null,
    debugInfo: null,
  };
}

describe("sessionTranscriptReducer", () => {
  it("keeps assistant thinking separate from visible answer text", () => {
    const session = makeSession();
    const pendingRun = createPendingUserRun("run-1", "hello", "2026-04-08T00:00:01Z");

    const thinkingStartEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      runId: "run-1",
      receivedAt: "2026-04-08T00:00:02Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Line one\nLine two" }],
        },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      },
    };

    const afterThinkingStart = reduceSessionTranscriptEvent(session, pendingRun, thinkingStartEnvelope);
    expect(afterThinkingStart?.pendingRun?.assistantEvent?.thinkingText).toBe("Line one\nLine two");
    expect(afterThinkingStart?.pendingRun?.assistantEvent?.message).toBe("");

    const thinkingDeltaEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      runId: "run-1",
      receivedAt: "2026-04-08T00:00:02Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Line one\nLine two\nLine three\nLine four" }],
        },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\nLine three\nLine four", partial: {} },
      },
    };

    const afterThinking = reduceSessionTranscriptEvent(afterThinkingStart!.session, afterThinkingStart!.pendingRun, thinkingDeltaEnvelope);
    expect(afterThinking?.pendingRun?.assistantEvent?.thinkingText).toBe("Line one\nLine two\nLine three\nLine four");
    expect(afterThinking?.pendingRun?.assistantEvent?.message).toBe("");

    const answerEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      runId: "run-1",
      receivedAt: "2026-04-08T00:00:03Z",
      event: {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Line one\nLine two\nLine three\nLine four" },
            { type: "text", text: "Visible answer" },
          ],
        },
      },
    };

    const afterTurnEnd = reduceSessionTranscriptEvent(afterThinking!.session, afterThinking!.pendingRun, answerEnvelope);
    const finalAssistantEvent = afterTurnEnd?.session.events.find((event) => event.runId === "run-1" && event.kind === "assistant");
    expect(afterTurnEnd?.clearPendingRun).toBe(true);
    expect(finalAssistantEvent?.thinkingText).toContain("Line four");
    expect(finalAssistantEvent?.message).toBe("Visible answer");
  });

  it("prefers the authoritative message snapshot during assistant streaming deltas", () => {
    const session = makeSession();

    const afterMessageStart = reduceSessionTranscriptEvent(session, undefined, {
      sessionId: session.id,
      runId: "run-stream",
      receivedAt: "2026-04-08T00:00:10Z",
      event: {
        type: "message_start",
        message: { role: "assistant" },
      },
    });

    const afterThinkingDelta = reduceSessionTranscriptEvent(afterMessageStart!.session, undefined, {
      sessionId: session.id,
      runId: "run-stream",
      receivedAt: "2026-04-08T00:00:11Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line" }],
        },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\nThird line\nFourth line", partial: {} },
      },
    });

    expect(afterThinkingDelta?.session.events.find((event) => event.runId === "run-stream" && event.kind === "assistant")?.thinkingText).toBe(
      "First line\nSecond line\nThird line\nFourth line",
    );

    const afterTextDelta = reduceSessionTranscriptEvent(afterThinkingDelta!.session, undefined, {
      sessionId: session.id,
      runId: "run-stream",
      receivedAt: "2026-04-08T00:00:12Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line" },
            { type: "text", text: "Visible answer" },
          ],
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Visible answer", partial: {} },
      },
    });

    expect(afterTextDelta?.session.events.find((event) => event.runId === "run-stream" && event.kind === "assistant")?.message).toBe("Visible answer");
  });

  it("creates a pending tool transcript row from toolcall composition events", () => {
    const session = makeSession();
    const envelope: SessionStreamEnvelope = {
      sessionId: session.id,
      runId: "run-tools",
      receivedAt: "2026-04-08T00:01:00Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCallId: "call-1",
              toolName: "write_file",
              input: { path: "src/live.ts", content: "const answer = 42;" },
            },
          ],
        },
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial: {} },
      },
    };

    const reduced = reduceSessionTranscriptEvent(session, undefined, envelope);
    const toolEvent = reduced?.session.events.find((event) => event.id === "tool-execution-call-1");
    expect(toolEvent).toBeTruthy();
    expect(toolEvent?.label).toContain("write_file(");
    expect(toolEvent?.message).toContain("src/live.ts");
    expect(toolEvent?.pending).toBe(true);
  });

  it("tracks session control lifecycle events without relying on prompt text", () => {
    const session = makeSession();
    const startEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:02:00Z",
      event: {
        type: "session_control_start",
        operationId: "control-1",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:02:00Z",
      },
    };

    const started = reduceSessionTranscriptEvent(session, undefined, startEnvelope);
    expect(started?.session.controlOperation?.kind).toBe("reload");
    expect(started?.session.controlOperation?.status).toBe("running");
    expect(started?.session.events.find((event) => event.id === "control-1")?.message).toContain("Reloading session");

    const endEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:02:03Z",
      event: {
        type: "session_control_end",
        operationId: "control-1",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:02:00Z",
        finishedAt: "2026-04-08T00:02:03Z",
        success: true,
        message: "Session reloaded.",
      },
    };

    const finished = reduceSessionTranscriptEvent(started!.session, undefined, endEnvelope);
    expect(finished?.session.controlOperation?.status).toBe("succeeded");
    expect(finished?.session.events.find((event) => event.id === "control-1")?.message).toBe("Session reloaded.");
    expect(finished?.refreshFromBackend).toBe(true);
  });

  it("surfaces failed reload control operations and preserves the backend error message", () => {
    const session = makeSession();
    const startEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:03:00Z",
      event: {
        type: "session_control_start",
        operationId: "control-failed",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:03:00Z",
      },
    };

    const started = reduceSessionTranscriptEvent(session, undefined, startEnvelope);
    const endEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:03:02Z",
      event: {
        type: "session_control_end",
        operationId: "control-failed",
        control: "reload",
        trigger: "manual",
        startedAt: "2026-04-08T00:03:00Z",
        finishedAt: "2026-04-08T00:03:02Z",
        success: false,
        error: "runtime_control_unsupported",
      },
    };

    const failed = reduceSessionTranscriptEvent(started!.session, undefined, endEnvelope);
    expect(failed?.session.controlOperation?.kind).toBe("reload");
    expect(failed?.session.controlOperation?.status).toBe("failed");
    expect(failed?.session.controlOperation?.message).toBe("runtime_control_unsupported");
    expect(failed?.session.events.find((event) => event.id === "control-failed")?.message).toBe("runtime_control_unsupported");
    expect(failed?.sessionActionError).toBe("runtime_control_unsupported");
    expect(failed?.refreshFromBackend).toBe(true);
  });

  it("preserves normalized model-auth failures from streamed assistant errors", () => {
    const session = makeSession();
    const reduced = reduceSessionTranscriptEvent(session, undefined, {
      sessionId: session.id,
      runId: "run-auth",
      receivedAt: "2026-04-08T00:04:00Z",
      event: {
        type: "message_update",
        normalizedError: {
          kind: "model_auth_required",
          code: "model_auth_required",
          reason: "missing",
          providerId: "openai-codex",
          providerName: "OpenAI Codex",
          modelId: "gpt-5.4",
          message: "The selected model can’t run because OpenAI Codex isn’t connected in Harness.",
          detail: "Reconnect OpenAI Codex in Settings → Harness → Setup, then retry.",
          settingsTab: "harness",
          settingsDetailTab: "setup",
          rawMessage: "OpenAI Codex missing credential in auth.json",
        },
        message: {
          role: "assistant",
          content: [],
        },
        assistantMessageEvent: {
          type: "error",
          error: "OpenAI Codex missing credential in auth.json",
        },
      },
    });

    expect(reduced?.session.status).toBe("failed");
    expect(reduced?.sessionActionError).toMatchObject({
      kind: "model_auth_required",
      providerId: "openai-codex",
      settingsDetailTab: "setup",
    });
  });

  it("keeps a queued follow-up row separate from the active streaming run", () => {
    const run1 = createPendingUserRun("run-1", "first message", "2026-04-08T00:05:00Z");
    const run2 = createPendingUserRun("run-2", "follow-up message", "2026-04-08T00:05:01Z");
    const session = applyPendingRunToSession(
      applyPendingRunToSession(makeSession(), run1),
      run2,
    );

    const reduced = reduceSessionTranscriptEvent(session, run1, {
      sessionId: session.id,
      runId: "run-1",
      receivedAt: "2026-04-08T00:05:02Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First answer", partial: {} },
      },
    });

    expect(reduced?.session.events.filter((event) => event.runId === "run-2" && event.kind === "user")).toHaveLength(1);
    expect(reduced?.session.events.find((event) => event.runId === "run-2" && event.kind === "user")?.message).toBe("follow-up message");
    expect(reduced?.session.events.filter((event) => event.runId === "run-1" && event.kind === "assistant")).toHaveLength(1);
    expect(reduced?.pendingRun?.runId).toBe("run-1");
  });

  it("surfaces an accepted-but-never-started delivery timeout as an actionable send failure", () => {
    const pendingRun = createPendingUserRun("run-timeout", "follow-up message", "2026-04-08T00:05:00Z");
    const session = applyPendingRunToSession(makeSession(), pendingRun);

    const reduced = reduceSessionTranscriptEvent(session, pendingRun, {
      sessionId: session.id,
      runId: "run-timeout",
      receivedAt: "2026-04-08T00:05:30Z",
      event: {
        type: "delivery_error",
        message: "Message was accepted but the session never started processing it. Orchestra reset the stale runtime so you can retry your message.",
        source: "orchestra",
      },
    });

    expect(reduced?.clearPendingRun).toBe(true);
    expect(reduced?.sessionActionError).toBe("Message was accepted but the session never started processing it. Orchestra reset the stale runtime so you can retry your message.");
    expect(reduced?.session.events.some((event) => event.runId === "run-timeout" && event.kind === "user")).toBe(false);
    expect(reduced?.session.events.find((event) => event.id === "delivery-error-run-timeout")?.message).toContain("never started processing");
  });

  it("drops optimistic rows once the backend record already includes that run", () => {
    const run1 = createPendingUserRun("run-1", "first message", "2026-04-08T00:06:00Z");
    const run2 = createPendingUserRun("run-2", "follow-up message", "2026-04-08T00:06:01Z");
    const authoritative = {
      ...makeSession(),
      status: "streaming" as const,
      updatedAt: "2026-04-08T00:06:02Z",
      events: [
        {
          id: "persisted-user-run-1",
          kind: "user" as const,
          message: "first message",
          timestamp: "2026-04-08T00:06:00Z",
          pending: false,
          runId: "run-1",
        },
      ],
    };

    const reconciled = reconcilePendingRunsWithSession(authoritative, {
      [run1.runId]: run1,
      [run2.runId]: run2,
    });

    expect(Object.keys(reconciled.pendingRuns)).toEqual(["run-2"]);
    expect(reconciled.session.events.filter((event) => event.runId === "run-1" && event.kind === "user")).toHaveLength(1);
    expect(reconciled.session.events.filter((event) => event.runId === "run-2" && event.kind === "user")).toHaveLength(1);
    expect(reconciled.session.events.find((event) => event.runId === "run-2" && event.kind === "user")?.pending).toBe(true);
  });

  it("tracks auto-compaction lifecycle separately from manual compaction", () => {
    const session = makeSession();
    const startEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:04:00Z",
      event: {
        type: "session_control_start",
        operationId: "auto-compact-1",
        control: "compact",
        trigger: "auto",
        startedAt: "2026-04-08T00:04:00Z",
      },
    };

    const started = reduceSessionTranscriptEvent(session, undefined, startEnvelope);
    expect(started?.session.controlOperation?.kind).toBe("compact");
    expect(started?.session.controlOperation?.trigger).toBe("auto");
    expect(started?.session.events.find((event) => event.id === "auto-compact-1")?.message).toBe("Auto-compacting session…");

    const endEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      receivedAt: "2026-04-08T00:04:03Z",
      event: {
        type: "session_control_end",
        operationId: "auto-compact-1",
        control: "compact",
        trigger: "auto",
        startedAt: "2026-04-08T00:04:00Z",
        finishedAt: "2026-04-08T00:04:03Z",
        success: true,
        message: "Session auto-compacted.",
      },
    };

    const finished = reduceSessionTranscriptEvent(started!.session, undefined, endEnvelope);
    expect(finished?.session.controlOperation?.status).toBe("succeeded");
    expect(finished?.session.controlOperation?.trigger).toBe("auto");
    expect(finished?.session.events.find((event) => event.id === "auto-compact-1")?.message).toBe("Session auto-compacted.");
    expect(finished?.session.events.find((event) => event.id === "auto-compact-1")?.message).not.toContain("/compact");
    expect(finished?.refreshFromBackend).toBe(true);
  });

  it("clears the optimistic pending run as soon as turn_end delivers the final assistant reply", () => {
    const session = makeSession();
    const pendingRun = createPendingUserRun("run-final", "hello", "2026-04-08T00:05:00Z");

    const reduced = reduceSessionTranscriptEvent(session, pendingRun, {
      sessionId: session.id,
      runId: "run-final",
      receivedAt: "2026-04-08T00:05:03Z",
      event: {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
        },
      },
    });

    expect(reduced?.clearPendingRun).toBe(true);
    expect(reduced?.pendingRun).toBeUndefined();
    expect(reduced?.session.status).toBe("active");
    expect(reduced?.session.events).toEqual([
      {
        id: "pending-user-run-final",
        kind: "user",
        message: "hello",
        timestamp: "2026-04-08T00:05:03Z",
        pending: false,
        runId: "run-final",
      },
      {
        id: "pending-assistant-run-final",
        kind: "assistant",
        message: "Final answer",
        timestamp: "2026-04-08T00:05:03Z",
        pending: false,
        thinking: false,
        thinkingText: "",
        runId: "run-final",
      },
    ]);
  });

  it("drops an empty assistant placeholder when turn_end completes without final assistant text", () => {
    const session = makeSession();
    const pendingRun = createPendingUserRun("run-empty", "hello", "2026-04-08T00:06:00Z");

    const started = reduceSessionTranscriptEvent(session, pendingRun, {
      sessionId: session.id,
      runId: "run-empty",
      receivedAt: "2026-04-08T00:06:01Z",
      event: {
        type: "message_start",
        message: { role: "assistant" },
      },
    });
    expect(started?.pendingRun?.assistantEvent?.pending).toBe(true);

    const reduced = reduceSessionTranscriptEvent(started!.session, started!.pendingRun, {
      sessionId: session.id,
      runId: "run-empty",
      receivedAt: "2026-04-08T00:06:03Z",
      event: {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [],
        },
      },
    });

    expect(reduced?.clearPendingRun).toBe(true);
    expect(reduced?.pendingRun).toBeUndefined();
    expect(reduced?.session.status).toBe("active");
    expect(reduced?.session.events).toEqual([
      {
        id: "pending-user-run-empty",
        kind: "user",
        message: "hello",
        timestamp: "2026-04-08T00:06:03Z",
        pending: false,
        runId: "run-empty",
      },
    ]);
  });
});
