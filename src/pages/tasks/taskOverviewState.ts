import { DEFAULT_TASK_LIST_SORT } from "../../lib/taskListQuery";
import type { TaskListSort, TaskListSortDirection, TaskListSortField, TaskTagMatchMode } from "../../types";

export type TaskBoardFilter = "all" | "attention" | "review" | "blocked" | "active" | "done" | "epics";
export type TaskBoardViewMode = "cards" | "table";

export interface TaskOverviewState {
  boardFilter: TaskBoardFilter;
  viewMode: TaskBoardViewMode;
  sort: TaskListSort;
  tags: string[];
  tagMatch: TaskTagMatchMode;
  filtersExpanded: boolean;
}

export const LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY = "orchestra.preferences.task-board-view-mode";
const TASK_OVERVIEW_STORAGE_KEY_PREFIX = "orchestra.preferences.task-overview.v1";
const DEFAULT_PROJECT_STORAGE_KEY = "default";

const TASK_BOARD_FILTERS: TaskBoardFilter[] = ["all", "attention", "review", "blocked", "active", "done", "epics"];
const TASK_BOARD_VIEW_MODES: TaskBoardViewMode[] = ["cards", "table"];
const TASK_LIST_SORT_FIELDS: TaskListSortField[] = ["updatedAt", "createdAt", "priority", "title", "status", "tags"];
const TASK_LIST_SORT_DIRECTIONS: TaskListSortDirection[] = ["desc", "asc"];
const TASK_TAG_MATCH_MODES: TaskTagMatchMode[] = ["any", "all"];

export const DEFAULT_TASK_OVERVIEW_STATE: TaskOverviewState = {
  boardFilter: "all",
  viewMode: "cards",
  sort: { ...DEFAULT_TASK_LIST_SORT },
  tags: [],
  tagMatch: "any",
  filtersExpanded: false,
};

export const TASK_OVERVIEW_SORT_FIELD_OPTIONS: Array<{ value: TaskListSortField; label: string }> = [
  { value: "updatedAt", label: "Updated" },
  { value: "createdAt", label: "Created" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "status", label: "Status" },
  { value: "tags", label: "Tags" },
];

export const TASK_OVERVIEW_SORT_DIRECTION_OPTIONS: Array<{ value: TaskListSortDirection; label: string }> = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

function buildDefaultState(overrides?: Partial<TaskOverviewState>): TaskOverviewState {
  return {
    boardFilter: overrides?.boardFilter ?? DEFAULT_TASK_OVERVIEW_STATE.boardFilter,
    viewMode: overrides?.viewMode ?? DEFAULT_TASK_OVERVIEW_STATE.viewMode,
    sort: overrides?.sort ?? { ...DEFAULT_TASK_OVERVIEW_STATE.sort },
    tags: overrides?.tags ?? DEFAULT_TASK_OVERVIEW_STATE.tags,
    tagMatch: overrides?.tagMatch ?? DEFAULT_TASK_OVERVIEW_STATE.tagMatch,
    filtersExpanded: overrides?.filtersExpanded ?? DEFAULT_TASK_OVERVIEW_STATE.filtersExpanded,
  };
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeSort(value: unknown): TaskListSort {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_TASK_OVERVIEW_STATE.sort };
  }

  const candidate = value as { field?: unknown; direction?: unknown };
  return {
    field: typeof candidate.field === "string" && TASK_LIST_SORT_FIELDS.includes(candidate.field as TaskListSortField)
      ? candidate.field as TaskListSortField
      : DEFAULT_TASK_OVERVIEW_STATE.sort.field,
    direction: typeof candidate.direction === "string" && TASK_LIST_SORT_DIRECTIONS.includes(candidate.direction as TaskListSortDirection)
      ? candidate.direction as TaskListSortDirection
      : DEFAULT_TASK_OVERVIEW_STATE.sort.direction,
  };
}

export function normalizeTaskOverviewState(value: unknown, fallback?: Partial<TaskOverviewState>): TaskOverviewState {
  const defaultState = buildDefaultState(fallback);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultState;
  }

  const candidate = value as Partial<TaskOverviewState>;
  return {
    boardFilter: typeof candidate.boardFilter === "string" && TASK_BOARD_FILTERS.includes(candidate.boardFilter)
      ? candidate.boardFilter
      : defaultState.boardFilter,
    viewMode: typeof candidate.viewMode === "string" && TASK_BOARD_VIEW_MODES.includes(candidate.viewMode)
      ? candidate.viewMode
      : defaultState.viewMode,
    sort: normalizeSort(candidate.sort),
    tags: normalizeTags(candidate.tags),
    tagMatch: typeof candidate.tagMatch === "string" && TASK_TAG_MATCH_MODES.includes(candidate.tagMatch)
      ? candidate.tagMatch
      : defaultState.tagMatch,
    filtersExpanded: typeof candidate.filtersExpanded === "boolean"
      ? candidate.filtersExpanded
      : defaultState.filtersExpanded,
  };
}

export function buildTaskOverviewStorageKey(projectId?: string | null) {
  return `${TASK_OVERVIEW_STORAGE_KEY_PREFIX}.${projectId ?? DEFAULT_PROJECT_STORAGE_KEY}`;
}

export function loadStoredTaskOverviewState(projectId?: string | null) {
  if (typeof window === "undefined") {
    return { ...DEFAULT_TASK_OVERVIEW_STATE, sort: { ...DEFAULT_TASK_OVERVIEW_STATE.sort }, tags: [] };
  }

  const stored = window.localStorage.getItem(buildTaskOverviewStorageKey(projectId));
  if (stored) {
    try {
      return normalizeTaskOverviewState(JSON.parse(stored));
    } catch {
      return { ...DEFAULT_TASK_OVERVIEW_STATE, sort: { ...DEFAULT_TASK_OVERVIEW_STATE.sort }, tags: [] };
    }
  }

  const legacyViewMode = window.localStorage.getItem(LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY);
  return normalizeTaskOverviewState({}, {
    viewMode: legacyViewMode === "table" || legacyViewMode === "cards" ? legacyViewMode : DEFAULT_TASK_OVERVIEW_STATE.viewMode,
  });
}

export function storeTaskOverviewState(projectId: string | null | undefined, state: TaskOverviewState) {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = normalizeTaskOverviewState(state);
  window.localStorage.setItem(buildTaskOverviewStorageKey(projectId), JSON.stringify(normalized));
  window.localStorage.setItem(LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY, normalized.viewMode);
}
