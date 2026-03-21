import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../src/types";

function deriveSessionActivityState(session: SessionRecord) {
  const latestEvent = session.events[session.events.length - 1];
  if (session.status === "failed") {
    return "error";
  }
  if (latestEvent?.pending && latestEvent?.message.includes("Running tools")) {
    return "tool_running";
  }
  if (latestEvent?.thinking) {
    return "thinking";
  }
  if (session.status === "streaming") {
    return "streaming";
  }
  return "idle";
}

describe("session transparency derived activity state", () => {
  function makeSession(partial: Partial<SessionRecord>): SessionRecord {
    return {
      id: "session-1",
      title: "Test Session",
      status: "idle",
      createdAt: "2026-03-21T00:00:00Z",
      updatedAt: "2026-03-21T00:00:00Z",
      subscribed: true,
      events: [],
      ...partial,
    };
  }

  it("marks failed sessions as error", () => {
    expect(deriveSessionActivityState(makeSession({ status: "failed" }))).toBe("error");
  });

  it("marks pending tool events as tool_running", () => {
    expect(
      deriveSessionActivityState(
        makeSession({
          events: [
            {
              id: "event-1",
              kind: "assistant",
              message: "Running tools…",
              timestamp: "2026-03-21T00:00:01Z",
              pending: true,
            },
          ],
        }),
      ),
    ).toBe("tool_running");
  });

  it("marks thinking events as thinking", () => {
    expect(
      deriveSessionActivityState(
        makeSession({
          events: [
            {
              id: "event-1",
              kind: "assistant",
              message: "",
              timestamp: "2026-03-21T00:00:01Z",
              thinking: true,
            },
          ],
        }),
      ),
    ).toBe("thinking");
  });

  it("marks streaming sessions as streaming when nothing else is active", () => {
    expect(deriveSessionActivityState(makeSession({ status: "streaming" }))).toBe("streaming");
  });

  it("falls back to idle", () => {
    expect(deriveSessionActivityState(makeSession({}))).toBe("idle");
  });
});
