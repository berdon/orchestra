import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionStreamEnvelope } from "../src/types";
import { createPendingUserRun, reduceSessionTranscriptEvent } from "../src/lib/sessionTranscriptReducer";

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
    expect(afterTurnEnd?.pendingRun?.assistantEvent?.thinkingText).toContain("Line four");
    expect(afterTurnEnd?.pendingRun?.assistantEvent?.message).toBe("Visible answer");
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
});
