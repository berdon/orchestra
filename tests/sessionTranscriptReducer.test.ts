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

    const thinkingEnvelope: SessionStreamEnvelope = {
      sessionId: session.id,
      runId: "run-1",
      receivedAt: "2026-04-08T00:00:02Z",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Line one\nLine two\nLine three\nLine four" }],
        },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      },
    };

    const afterThinking = reduceSessionTranscriptEvent(session, pendingRun, thinkingEnvelope);
    expect(afterThinking?.pendingRun?.assistantEvent?.thinkingText).toContain("Line one");
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
});
