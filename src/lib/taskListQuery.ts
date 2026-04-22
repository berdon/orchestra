import { normalizeTaskTags } from "./taskTags";
import type { TaskListQuery, TaskListSort, TaskSummary } from "../types";

export const DEFAULT_TASK_LIST_SORT: TaskListSort = {
  field: "updatedAt",
  direction: "desc",
};

const PRIORITY_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

const STATUS_ORDER: Record<string, number> = {
  draft: 0,
  ready: 1,
  in_progress: 2,
  blocked: 3,
  in_review: 4,
  completed: 5,
  canceled: 6,
};

function normalizeTagValue(tag: string) {
  return tag.trim().toLowerCase();
}

function buildTagSortKey(task: Pick<TaskSummary, "tags">) {
  return getTaskTags(task).join("\u0000");
}

export function getTaskTags(task: Pick<TaskSummary, "tags">) {
  const tags = Array.isArray(task.tags) ? task.tags : [];
  return normalizeTaskTags(tags);
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function compareNumbers(left: number, right: number) {
  return left - right;
}

function compareTimestamps(left: string, right: string) {
  return compareNumbers(Date.parse(left), Date.parse(right));
}

function compareTagSortValues(left: Pick<TaskSummary, "tags">, right: Pick<TaskSummary, "tags">, direction: TaskListSort["direction"]) {
  const leftKey = buildTagSortKey(left);
  const rightKey = buildTagSortKey(right);
  const leftUntagged = leftKey.length === 0;
  const rightUntagged = rightKey.length === 0;

  if (leftUntagged !== rightUntagged) {
    return leftUntagged ? 1 : -1;
  }

  const directionMultiplier = direction === "asc" ? 1 : -1;
  return compareStrings(leftKey, rightKey) * directionMultiplier;
}

function compareTaskValues(left: TaskSummary, right: TaskSummary, sort: TaskListSort) {
  switch (sort.field) {
    case "createdAt":
      return compareTimestamps(left.createdAt, right.createdAt);
    case "priority":
      return compareNumbers(PRIORITY_ORDER[left.priority] ?? Number.MAX_SAFE_INTEGER, PRIORITY_ORDER[right.priority] ?? Number.MAX_SAFE_INTEGER);
    case "title":
      return compareStrings(left.title, right.title);
    case "status":
      return compareNumbers(STATUS_ORDER[left.status] ?? Number.MAX_SAFE_INTEGER, STATUS_ORDER[right.status] ?? Number.MAX_SAFE_INTEGER);
    case "updatedAt":
    default:
      return compareTimestamps(left.updatedAt, right.updatedAt);
  }
}

function compareTaskSummaries(left: TaskSummary, right: TaskSummary, sort: TaskListSort) {
  const direction = sort.direction === "asc" ? 1 : -1;
  const primary = sort.field === "tags"
    ? compareTagSortValues(left, right, sort.direction)
    : compareTaskValues(left, right, sort) * direction;
  if (primary !== 0) {
    return primary;
  }

  const updatedAt = compareTimestamps(left.updatedAt, right.updatedAt) * -1;
  if (updatedAt !== 0) {
    return updatedAt;
  }

  const createdAt = compareTimestamps(left.createdAt, right.createdAt) * -1;
  if (createdAt !== 0) {
    return createdAt;
  }

  const numberCompare = compareStrings(left.number, right.number);
  if (numberCompare !== 0) {
    return numberCompare;
  }

  return compareStrings(left.id, right.id);
}

export function filterTasksByTags(tasks: TaskSummary[], query?: Pick<TaskListQuery, "tags" | "tagMatch"> | null) {
  const selectedTags = normalizeTaskTags((query?.tags ?? []).map(normalizeTagValue));
  if (selectedTags.length === 0) {
    return tasks;
  }

  const tagMatch = query?.tagMatch === "all" ? "all" : "any";
  return tasks.filter((task) => {
    const taskTags = getTaskTags(task);
    return tagMatch === "all"
      ? selectedTags.every((tag) => taskTags.includes(tag))
      : selectedTags.some((tag) => taskTags.includes(tag));
  });
}

export function sortTasks(tasks: TaskSummary[], sort?: TaskListSort | null) {
  const resolvedSort = sort ?? DEFAULT_TASK_LIST_SORT;
  return tasks.slice().sort((left, right) => compareTaskSummaries(left, right, resolvedSort));
}

export function applyTaskListQuery(tasks: TaskSummary[], query?: TaskListQuery | null) {
  return sortTasks(filterTasksByTags(tasks, query), query?.sort ?? DEFAULT_TASK_LIST_SORT);
}
