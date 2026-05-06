import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { OrchestraClientServiceBindings } from "../src/lib/orchestraClient/serviceBindings";
import { createOrchestraClient } from "../src/lib/orchestraClient/baseClient";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createBindings(overrides?: Partial<OrchestraClientServiceBindings>): OrchestraClientServiceBindings {
  return {
    app: {} as OrchestraClientServiceBindings["app"],
    catalog: {} as OrchestraClientServiceBindings["catalog"],
    projects: {} as OrchestraClientServiceBindings["projects"],
    settings: {} as OrchestraClientServiceBindings["settings"],
    workers: {} as OrchestraClientServiceBindings["workers"],
    workflows: {} as OrchestraClientServiceBindings["workflows"],
    policies: {} as OrchestraClientServiceBindings["policies"],
    channels: {} as OrchestraClientServiceBindings["channels"],
    skills: {} as OrchestraClientServiceBindings["skills"],
    notes: {} as OrchestraClientServiceBindings["notes"],
    tasks: {
      list: vi.fn(),
      update: vi.fn(),
    } as unknown as OrchestraClientServiceBindings["tasks"],
    inbox: {} as OrchestraClientServiceBindings["inbox"],
    sessions: {} as OrchestraClientServiceBindings["sessions"],
    ...overrides,
  };
}

describe("createOrchestraClient task list coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces identical concurrent task list requests", async () => {
    const deferred = createDeferredPromise<any[]>();
    const list = vi.fn(() => deferred.promise);
    const client = createOrchestraClient(
      async () => ({ contractVersion: "test" } as any),
      createBindings({
        tasks: {
          list,
          update: vi.fn(),
        } as unknown as OrchestraClientServiceBindings["tasks"],
      }),
    );

    const firstPromise = client.tasks.list({ includeArchived: false, projectId: "orchestra" });
    const secondPromise = client.tasks.list({ includeArchived: false, projectId: "orchestra" });

    expect(list).toHaveBeenCalledTimes(1);

    deferred.resolve([]);
    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([[], []]);
  });

  it("does not coalesce task list requests for different query keys", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const client = createOrchestraClient(
      async () => ({ contractVersion: "test" } as any),
      createBindings({
        tasks: {
          list,
          update: vi.fn(),
        } as unknown as OrchestraClientServiceBindings["tasks"],
      }),
    );

    await Promise.all([
      client.tasks.list({ includeArchived: false, projectId: "orchestra" }),
      client.tasks.list({ includeArchived: false, projectId: "other-project" }),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
  });

  it("invalidates the short-lived task list cache after a task mutation", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const update = vi.fn().mockResolvedValue({ id: "task-1" });
    const client = createOrchestraClient(
      async () => ({ contractVersion: "test" } as any),
      createBindings({
        tasks: {
          list,
          update,
        } as unknown as OrchestraClientServiceBindings["tasks"],
      }),
    );

    await client.tasks.list({ includeArchived: false, projectId: "orchestra" });
    await client.tasks.list({ includeArchived: false, projectId: "orchestra" });
    expect(list).toHaveBeenCalledTimes(1);

    await client.tasks.update("task-1", {} as any);
    await client.tasks.list({ includeArchived: false, projectId: "orchestra" });

    expect(list).toHaveBeenCalledTimes(2);
  });
});
