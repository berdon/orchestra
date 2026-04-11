import { describe, expect, it } from "vitest";

import { compareSessionRecords, getSessionListMetadata, getSessionListTitle, sortSessionRecords } from "../src/lib/sessionList";
import type { SessionRecord } from "../src/types";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: overrides.id ?? "session-1",
    title: overrides.title ?? "Fallback session title",
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-04-10T00:00:00Z",
    subscribed: overrides.subscribed ?? false,
    events: overrides.events ?? [],
    terminalAttached: overrides.terminalAttached ?? false,
    activityState: overrides.activityState ?? "idle",
    activeToolName: overrides.activeToolName ?? null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    debugInfo: overrides.debugInfo ?? null,
    taskId: overrides.taskId ?? null,
    taskNumber: overrides.taskNumber ?? null,
    taskTitle: overrides.taskTitle ?? null,
    workerType: overrides.workerType ?? null,
    workerName: overrides.workerName ?? null,
  };
}

describe("sessionList", () => {
  it("sorts task sessions deterministically by task number then worker", () => {
    const sessions = [
      makeSession({ id: "session-3", taskNumber: "ORC-10", taskTitle: "Tenth task", workerName: "Reviewer" }),
      makeSession({ id: "session-2", taskNumber: "ORC-2", taskTitle: "Second task", workerName: "Builder" }),
      makeSession({ id: "session-1", taskNumber: "ORC-2", taskTitle: "Second task", workerName: "Analyst" }),
      makeSession({ id: "session-4", title: "Standalone session", workerName: null }),
    ];

    expect(sortSessionRecords(sessions).map((session) => session.id)).toEqual([
      "session-1",
      "session-2",
      "session-3",
      "session-4",
    ]);
  });

  it("prefers task title and combined task/worker metadata for session rows", () => {
    const session = makeSession({
      title: "Internal runtime session title",
      taskNumber: "ORC-42",
      taskTitle: "Implement deterministic session rows",
      workerName: "Reviewer",
    });

    expect(getSessionListMetadata(session)).toBe("ORC-42 · Reviewer");
    expect(getSessionListTitle(session)).toBe("Implement deterministic session rows");
  });

  it("falls back to standalone session labels without task metadata", () => {
    const session = makeSession({ title: "Scratchpad", workerName: null });

    expect(getSessionListMetadata(session)).toBe("Standalone session");
    expect(getSessionListTitle(session)).toBe("Scratchpad");
    expect(compareSessionRecords(session, makeSession({ id: "session-2", title: "Zebra" }))).toBeLessThan(0);
  });
});
