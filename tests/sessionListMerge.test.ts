import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../src/types";
import { reconcileListedSessions } from "../src/lib/sessionListMerge";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    title: "Test session",
    status: "idle",
    createdAt: "2026-04-08T00:00:00Z",
    updatedAt: "2026-04-08T00:00:00Z",
    subscribed: false,
    events: [],
    terminalAttached: false,
    activityState: "idle",
    activeToolName: null,
    lastActivityAt: null,
    debugInfo: null,
    ...overrides,
  };
}

describe("sessionListMerge", () => {
  it("preserves loaded transcript events and debug info when a retained viewed session refresh only returns a summary", () => {
    const existing = makeSession({
      events: [
        {
          id: "assistant-1",
          kind: "assistant",
          message: "Visible answer",
          timestamp: "2026-04-08T00:00:01Z",
        },
      ],
      debugInfo: {
        projectRoot: "/workspace/orchestra",
        managedRepositoryPath: "/workspace/orchestra/repository",
        worktreePath: "/workspace/orchestra/worktrees/agent-02",
        sessionCwd: "/workspace/orchestra/worktrees/agent-02",
      },
      updatedAt: "2026-04-08T00:00:02Z",
    });

    const listed = makeSession({
      updatedAt: "2026-04-08T00:00:03Z",
      events: [],
      debugInfo: null,
    });

    const [merged] = reconcileListedSessions([existing], [listed], {
      preserveDetailedSessionIds: [existing.id],
    });
    expect(merged?.events).toEqual(existing.events);
    expect(merged?.debugInfo).toEqual(existing.debugInfo);
    expect(merged?.updatedAt).toBe(listed.updatedAt);
  });

  it("preserves live runtime state for subscribed streaming sessions during summary refreshes", () => {
    const existing = makeSession({
      subscribed: true,
      status: "streaming",
      activityState: "tool_running",
      activeToolName: "bash",
      lastActivityAt: "2026-04-08T00:00:05Z",
      updatedAt: "2026-04-08T00:00:05Z",
      events: [
        {
          id: "tool-1",
          kind: "system",
          message: "Running tools…",
          timestamp: "2026-04-08T00:00:05Z",
          pending: true,
        },
      ],
    });

    const listed = makeSession({
      subscribed: true,
      status: "idle",
      updatedAt: "2026-04-08T00:00:04Z",
      events: [],
    });

    const [merged] = reconcileListedSessions([existing], [listed]);
    expect(merged?.status).toBe("streaming");
    expect(merged?.activityState).toBe("tool_running");
    expect(merged?.activeToolName).toBe("bash");
    expect(merged?.lastActivityAt).toBe(existing.lastActivityAt);
    expect(merged?.updatedAt).toBe(existing.updatedAt);
  });

  it("preserves optimistic runtime state while a pending run is still active", () => {
    const existing = makeSession({
      status: "streaming",
      updatedAt: "2026-04-08T00:00:06Z",
      activityState: "streaming",
    });
    const listed = makeSession({
      status: "active",
      updatedAt: "2026-04-08T00:00:05Z",
    });

    const [merged] = reconcileListedSessions([existing], [listed], {
      pendingSessionIds: [existing.id],
    });
    expect(merged?.status).toBe("streaming");
    expect(merged?.activityState).toBe("streaming");
    expect(merged?.updatedAt).toBe(existing.updatedAt);
  });

  it("drops transcript details for non-retained sessions so old history can collapse back to summaries", () => {
    const existing = makeSession({
      events: [
        {
          id: "assistant-1",
          kind: "assistant",
          message: "Visible answer",
          timestamp: "2026-04-08T00:00:01Z",
        },
      ],
      debugInfo: {
        projectRoot: "/workspace/orchestra",
        managedRepositoryPath: "/workspace/orchestra/repository",
        worktreePath: "/workspace/orchestra/worktrees/agent-02",
        sessionCwd: "/workspace/orchestra/worktrees/agent-02",
      },
    });
    const listed = makeSession({ events: [], debugInfo: null });

    const [merged] = reconcileListedSessions([existing], [listed], {
      preserveDetailedSessionIds: [],
    });

    expect(merged?.events).toEqual([]);
    expect(merged?.debugInfo).toBeNull();
  });
});
