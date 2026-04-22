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

describe("mock task tag parity", () => {
  beforeEach(() => {
    installMockWindow();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("rejects invalid create inputs without persisting a partial task", async () => {
    const { createTask, listTasks } = await import("../src/lib/tauri");

    await expect(
      createTask(taskInput("invalid", ["backend", "not ok"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID),
    ).rejects.toThrow("tags[1]: Tags must use lower-case letters");

    const listed = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      sortBy: "title",
      sortDirection: "asc",
    });
    expect(listed.some((task) => task.title === "invalid")).toBe(false);
  });

  test("rejects invalid updates without mutating the existing stored tags", async () => {
    const { createTask, getTask, listTasks, updateTask } = await import("../src/lib/tauri");

    const created = await createTask(taskInput("mutable", ["Backend", "urgent"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    expect(created.tags).toEqual(["backend", "urgent"]);

    await expect(
      updateTask(created.id, taskInput("mutable", ["ops", "bad tag"])),
    ).rejects.toThrow("Tags must use lower-case letters");

    const loaded = await getTask(created.id);
    expect(loaded.tags).toEqual(["backend", "urgent"]);

    const listed = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      tags: ["URGENT"],
      tagMatch: "all",
      sortBy: "tags",
      sortDirection: "asc",
    });
    expect(listed.map((task) => task.tags)).toEqual([["backend", "urgent"]]);
  });

  test("keeps untagged tasks last when mock lists are sorted by tags", async () => {
    const { createTask, listTasks } = await import("../src/lib/tauri");

    await createTask(taskInput("backend", ["backend"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("api+backend", ["backend", "api"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("api", ["api"]), DEFAULT_INSTALL_BASELINE_PROJECT_ID);
    await createTask(taskInput("untagged"), DEFAULT_INSTALL_BASELINE_PROJECT_ID);

    const ascending = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      sortBy: "tags",
      sortDirection: "asc",
    });
    expect(ascending.slice(0, 4).map((task) => task.title)).toEqual(["api", "api+backend", "backend", "untagged"]);

    const descending = await listTasks({
      projectId: DEFAULT_INSTALL_BASELINE_PROJECT_ID,
      sortBy: "tags",
      sortDirection: "desc",
    });
    expect(descending.slice(0, 4).map((task) => task.title)).toEqual(["backend", "api+backend", "api", "untagged"]);
  });
});
