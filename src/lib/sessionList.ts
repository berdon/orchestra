import type { SessionRecord } from "../types";

function parseTaskNumber(taskNumber?: string | null) {
  if (!taskNumber) {
    return { hasTask: false, prefix: "", sequence: Number.POSITIVE_INFINITY, suffix: "" };
  }

  const match = taskNumber.match(/^([A-Za-z]+)-([0-9]+)(.*)$/);
  if (!match) {
    return { hasTask: true, prefix: taskNumber.toLowerCase(), sequence: Number.POSITIVE_INFINITY, suffix: "" };
  }

  return {
    hasTask: true,
    prefix: match[1].toLowerCase(),
    sequence: Number.parseInt(match[2] ?? "", 10),
    suffix: (match[3] ?? "").toLowerCase(),
  };
}

export function getSessionListMetadata(session: SessionRecord) {
  const metadata = [session.taskNumber, session.workerName].filter(Boolean).join(" · ");
  return metadata || (session.workerName ?? "Standalone session");
}

export function getSessionListTitle(session: SessionRecord) {
  return session.taskTitle ?? session.title;
}

export function compareSessionRecords(left: SessionRecord, right: SessionRecord) {
  const leftTask = parseTaskNumber(left.taskNumber);
  const rightTask = parseTaskNumber(right.taskNumber);

  if (leftTask.hasTask !== rightTask.hasTask) {
    return leftTask.hasTask ? -1 : 1;
  }

  const prefixCompare = leftTask.prefix.localeCompare(rightTask.prefix, undefined, { numeric: true, sensitivity: "base" });
  if (prefixCompare !== 0) {
    return prefixCompare;
  }

  if (leftTask.sequence !== rightTask.sequence) {
    return leftTask.sequence - rightTask.sequence;
  }

  const suffixCompare = leftTask.suffix.localeCompare(rightTask.suffix, undefined, { numeric: true, sensitivity: "base" });
  if (suffixCompare !== 0) {
    return suffixCompare;
  }

  const workerCompare = (left.workerName ?? "").localeCompare(right.workerName ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
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
