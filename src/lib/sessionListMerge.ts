import type { SessionRecord } from "../types";

interface ReconcileListedSessionsOptions {
  preserveDetailedSessionIds?: Iterable<string>;
  pendingSessionIds?: Iterable<string>;
}

function parseTimestamp(timestamp: string) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function shouldPreserveDetailedState(
  existing: SessionRecord | undefined,
  listed: SessionRecord,
  preservedDetailedSessionIds: Set<string>,
) {
  return Boolean(
    existing
    && preservedDetailedSessionIds.has(listed.id)
    && listed.events.length === 0
    && existing.events.length > 0,
  );
}

function shouldPreserveRuntimeState(existing: SessionRecord | undefined, pendingSessionIds: Set<string>) {
  if (!existing) {
    return false;
  }

  if (pendingSessionIds.has(existing.id)) {
    return true;
  }

  if (!existing.subscribed) {
    return false;
  }

  return existing.status === "streaming"
    || existing.status === "failed"
    || existing.activityState === "thinking"
    || existing.activityState === "tool_running"
    || existing.activityState === "streaming"
    || existing.activityState === "error";
}

export function reconcileListedSessions(
  currentSessions: SessionRecord[],
  listedSessions: SessionRecord[],
  options: ReconcileListedSessionsOptions = {},
) {
  const currentById = new Map(currentSessions.map((session) => [session.id, session]));
  const pendingIds = new Set(options.pendingSessionIds ?? []);
  const preservedDetailedSessionIds = new Set(options.preserveDetailedSessionIds ?? []);

  return listedSessions.map((listedSession) => {
    const existingSession = currentById.get(listedSession.id);
    if (!existingSession) {
      return listedSession;
    }

    const preserveDetailedState = shouldPreserveDetailedState(existingSession, listedSession, preservedDetailedSessionIds);
    const preserveRuntimeState = shouldPreserveRuntimeState(existingSession, pendingIds);
    const preserveDerivedState = preserveDetailedState || preserveRuntimeState;

    return {
      ...listedSession,
      updatedAt: preserveDerivedState && parseTimestamp(existingSession.updatedAt) > parseTimestamp(listedSession.updatedAt)
        ? existingSession.updatedAt
        : listedSession.updatedAt,
      status: preserveRuntimeState ? existingSession.status : listedSession.status,
      events: preserveDetailedState ? existingSession.events : listedSession.events,
      debugInfo: preserveDetailedState ? (listedSession.debugInfo ?? existingSession.debugInfo) : listedSession.debugInfo,
      activityState: preserveDerivedState ? existingSession.activityState : listedSession.activityState,
      activeToolName: preserveDerivedState ? existingSession.activeToolName : listedSession.activeToolName,
      lastActivityAt: preserveDerivedState
        ? existingSession.lastActivityAt ?? listedSession.lastActivityAt
        : listedSession.lastActivityAt,
    };
  });
}
