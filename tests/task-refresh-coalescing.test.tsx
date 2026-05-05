// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCoalescedRefresh } from "../src/lib/orchestraData/coalescedRefresh";
import { useTaskAutoRefresh } from "../src/lib/orchestraData/tasks";

let subscribedHandler: ((event: any) => void) | null = null;

vi.mock("../src/lib/orchestraData/events", () => ({
  useOrchestraEventSubscription: (handler: (event: any) => void) => {
    subscribedHandler = handler;
  },
}));

function createDeferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("task refresh coalescing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribedHandler = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("coalesces bursty refresh requests and schedules one trailing run after in-flight work completes", async () => {
    const firstRefresh = createDeferredPromise();
    const secondRefresh = createDeferredPromise();
    const refresh = vi.fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);
    let requestRefresh: (() => void) | null = null;

    function Harness() {
      requestRefresh = useCoalescedRefresh(refresh);
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        requestRefresh?.();
      }
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        requestRefresh?.();
      }
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRefresh.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(refresh).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRefresh.resolve();
      await Promise.resolve();
    });
  });

  it("treats task.change as the canonical invalidation signal for task auto-refresh", async () => {
    const refreshTasks = vi.fn();
    const refreshTaskDetail = vi.fn();
    const refreshTaskSchedule = vi.fn();

    function Harness() {
      useTaskAutoRefresh({
        selectedTaskId: "task-1",
        selectedScheduleId: null,
        canRefreshSelectedTask: true,
        canRefreshSelectedSchedule: false,
        refreshTasks,
        refreshTaskDetail,
        refreshTaskSchedule,
      });
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
    });

    expect(subscribedHandler).toBeTruthy();

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        subscribedHandler?.({
          kind: "session.stream",
          sessionId: "session-1",
          runId: `run-${index}`,
          receivedAt: new Date().toISOString(),
          event: {
            type: "tool_execution_end",
            toolCallId: `call-${index}`,
            toolName: "update_task",
            args: { taskId: "task-1" },
            isError: false,
          },
        });
      }
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(refreshTasks).not.toHaveBeenCalled();
    expect(refreshTaskDetail).not.toHaveBeenCalled();

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        subscribedHandler?.({
          kind: "task.change",
          taskIds: ["task-1"],
          reason: `burst-${index}`,
        });
      }
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(refreshTasks).toHaveBeenCalledTimes(1);
    expect(refreshTaskDetail).toHaveBeenCalledTimes(1);
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
  });
});
