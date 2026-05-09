export const TASK_DETAIL_HISTORY_STATE_KEY = "orchestraTaskDetailFromOverview";

type HistoryStateRecord = Record<string, unknown>;

export function getHistoryStateRecord(state: unknown): HistoryStateRecord {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {};
  }
  return { ...(state as HistoryStateRecord) };
}

export function hasTaskDetailOverviewHistoryEntry(state: unknown): boolean {
  return getHistoryStateRecord(state)[TASK_DETAIL_HISTORY_STATE_KEY] === true;
}

export function withTaskDetailOverviewHistoryFlag(
  state: unknown,
  enabled: boolean,
): HistoryStateRecord {
  const nextState = getHistoryStateRecord(state);
  if (enabled) {
    nextState[TASK_DETAIL_HISTORY_STATE_KEY] = true;
  } else {
    delete nextState[TASK_DETAIL_HISTORY_STATE_KEY];
  }
  return nextState;
}
