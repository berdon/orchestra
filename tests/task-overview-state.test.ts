import { beforeEach, describe, expect, test } from "vitest";

import {
  LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY,
  buildTaskOverviewStorageKey,
  loadStoredTaskOverviewState,
  normalizeTaskOverviewState,
  storeTaskOverviewState,
} from "../src/pages/tasks/taskOverviewState";

function createMockStorage() {
  const values = new Map<string, string>();
  return {
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const windowWithStorage = {
  localStorage: createMockStorage(),
};

Object.assign(globalThis, { window: windowWithStorage });

describe("taskOverviewState", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("migrates the legacy view-mode preference when project state is absent", () => {
    window.localStorage.setItem(LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY, "table");

    expect(loadStoredTaskOverviewState("project-1")).toMatchObject({
      boardFilter: "all",
      viewMode: "table",
      sort: { field: "updatedAt", direction: "desc" },
      tags: [],
      tagMatch: "any",
    });
  });

  test("stores the normalized state under a per-project key", () => {
    storeTaskOverviewState("project-2", {
      boardFilter: "blocked",
      viewMode: "table",
      sort: { field: "tags", direction: "asc" },
      tags: ["backend", "backend", " urgent "],
      tagMatch: "all",
    });

    expect(JSON.parse(window.localStorage.getItem(buildTaskOverviewStorageKey("project-2")) ?? "null")).toEqual({
      boardFilter: "blocked",
      viewMode: "table",
      sort: { field: "tags", direction: "asc" },
      tags: ["backend", "urgent"],
      tagMatch: "all",
    });
    expect(window.localStorage.getItem(LEGACY_TASK_BOARD_VIEW_MODE_STORAGE_KEY)).toBe("table");
  });

  test("normalizes malformed stored values without crashing", () => {
    expect(normalizeTaskOverviewState({
      boardFilter: "not-real",
      viewMode: "spreadsheet",
      sort: { field: "oops", direction: "sideways" },
      tags: ["backend", null, "", "backend", "design"],
      tagMatch: "sometimes",
    })).toEqual({
      boardFilter: "all",
      viewMode: "cards",
      sort: { field: "updatedAt", direction: "desc" },
      tags: ["backend", "design"],
      tagMatch: "any",
    });
  });
});
