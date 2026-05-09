import { parseTaskNumber } from "./taskPrefixes";
import type { SessionListVisibility, SessionRecord } from "../types";

export function getSessionListMetadata(session: SessionRecord) {
  const metadata = [session.taskNumber, session.workerName].filter(Boolean).join(" · ");
  return metadata || (session.workerName ?? "Standalone session");
}

export function getSessionListTitle(session: SessionRecord) {
  return session.taskTitle ?? session.title;
}

function sessionTaskIdentity(session: SessionRecord) {
  return session.activeTaskId ?? session.taskId ?? session.taskNumber ?? null;
}

function sessionVisibilityRank(visibility?: SessionListVisibility | null) {
  switch (visibility) {
    case "active":
      return 0;
    case "closed":
      return 1;
    case "hidden":
      return 2;
    default:
      return 3;
  }
}

export function compareSessionRecords(left: SessionRecord, right: SessionRecord) {
  const leftTask = parseTaskNumber(left.taskNumber);
  const rightTask = parseTaskNumber(right.taskNumber);

  if (leftTask.hasTask !== rightTask.hasTask) {
    return leftTask.hasTask ? -1 : 1;
  }

  const prefixCompare = leftTask.prefix.localeCompare(
    rightTask.prefix,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
  if (prefixCompare !== 0) {
    return prefixCompare;
  }

  if (leftTask.sequence !== rightTask.sequence) {
    return leftTask.sequence - rightTask.sequence;
  }

  const suffixCompare = leftTask.suffix.localeCompare(
    rightTask.suffix,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
  if (suffixCompare !== 0) {
    return suffixCompare;
  }

  const leftTaskIdentity = sessionTaskIdentity(left);
  const rightTaskIdentity = sessionTaskIdentity(right);
  const sameTask = Boolean(leftTaskIdentity) && leftTaskIdentity === rightTaskIdentity;

  if (sameTask) {
    const leftHasActiveTask = Boolean(left.activeTaskId);
    const rightHasActiveTask = Boolean(right.activeTaskId);
    if (leftHasActiveTask !== rightHasActiveTask) {
      return leftHasActiveTask ? -1 : 1;
    }

    const visibilityCompare =
      sessionVisibilityRank(left.listVisibility) -
      sessionVisibilityRank(right.listVisibility);
    if (visibilityCompare !== 0) {
      return visibilityCompare;
    }

    const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedCompare !== 0) {
      return updatedCompare;
    }

    const createdCompare = right.createdAt.localeCompare(left.createdAt);
    if (createdCompare !== 0) {
      return createdCompare;
    }
  }

  const workerCompare = (left.workerName ?? "").localeCompare(
    right.workerName ?? "",
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
  if (workerCompare !== 0) {
    return workerCompare;
  }

  const titleCompare = getSessionListTitle(left).localeCompare(getSessionListTitle(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (titleCompare !== 0) {
    return titleCompare;
  }

  const fallbackTitleCompare = left.title.localeCompare(right.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (fallbackTitleCompare !== 0) {
    return fallbackTitleCompare;
  }

  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare !== 0) {
    return createdCompare;
  }

  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
}

export function sortSessionRecords(sessions: SessionRecord[]) {
  return [...sessions].sort(compareSessionRecords);
}
