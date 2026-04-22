import { beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_INSTALL_BASELINE_PROJECT_ID } from "../src/lib/defaultInstallBaseline";
import type { TaskUpsertInput } from "../src/types";

function taskInput(title: string, tags: string[] = []): TaskUpsertInput {
  return {
    title,
    description: null,
    type: "task",
    tags,
    status: "ready",
    priority: "P2",
    workflowId: null,
    currentLaneId: null,
    assigneeType: "unassigned",
    assigneeId: null,
    repositoryId: null,
    repositoryIds: [],
    parentTaskId: null,
    whipMaxAttempts: null,
    archived: false,
  };
}

function installMockWindow() {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      location: { search: "" },
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

describe("mock task list tag behavior", () => {
  beforeEach(() => {
    installMockWindow();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("filters by exact tags with all/any matching and sorts by canonical tag key", async () => {
    const { createTask, listTasks } = await import("../src/lib/tauri");

    await createTask(taskInput("backend", ["backend"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("api+backend", ["backend", "api"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("api", ["api"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("untagged"), DEFAULT_INSTALL_BASELINE_PROJECT_ID);

    const allMatch = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      tags: [" backend ", "API"],
      tagMatch: "all",
      sortBy: "title",
      sortDirection: "asc",
    });
    expect(allMatch.map((task) => task.title)).toEqual(["api+backend"]);

    const anyMatchAscending = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      tags: ["backend", "api"],
      tagMatch: "any",
      sortBy: "tags",
      sortDirection: "asc",
    });
    expect(anyMatchAscending.map((task) => task.title)).toEqual(["api", "api+backend", "backend"]);

    const allTasksDescending = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      sortBy: "tags",
      sortDirection: "desc",
    });
    expect(allTasksDescending.slice(0, 4).map((task) => task.title)).toEqual(["backend", "api+backend", "api", "untagged"]);
    expect(allTasksDescending.slice(4).every((task) => (task.tags ?? []).length === 0)).toBe(true);
  });

  test("round-trips normalized tags through mock create and update paths", async () => {
    const { createTask, listTasks, updateTask } = await import("../src/lib/tauri");

    const created = await createTask(
      taskInput("mutable", ["Urgent", " backend ", "urgent"]),
      DEFAULT_INSTALL_BASELINE_PROJECT_ID,
    );
    expect(created.tags).toEqual(["backend", "urgent"]);

    const updated = await updateTask(created.id, {
      ...taskInput("mutable", ["ops", " backend ", "OPS"]),
      archived: created.archived,
    });
    expect(updated.tags).toEqual(["backend", "ops"]);

    const listed = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      tags: ["backend", "ops"],
      tagMatch: "all",
    });
    expect(listed.map((task) => task.tags)).toEqual([["backend", "ops"]]);
  });
});
