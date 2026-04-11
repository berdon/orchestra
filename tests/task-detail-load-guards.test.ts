import { describe, expect, it } from "vitest";

import { shouldApplyTaskDetailLoad, shouldApplyTaskScheduleLoad } from "../src/pages/tasks/taskDetailLoadGuards";

describe("task detail load guards", () => {
  it("accepts only the latest matching task detail load for the active detail route", () => {
    expect(shouldApplyTaskDetailLoad({ kind: "detail", taskId: "task-b" }, "task-b", 4, 4)).toBe(true);
    expect(shouldApplyTaskDetailLoad({ kind: "detail", taskId: "task-b" }, "task-a", 3, 4)).toBe(false);
    expect(shouldApplyTaskDetailLoad({ kind: "detail", taskId: "task-b" }, "task-b", 3, 4)).toBe(false);
    expect(shouldApplyTaskDetailLoad({ kind: "overview" }, "task-b", 4, 4)).toBe(false);
  });

  it("accepts only the latest matching schedule detail load for the active schedule route", () => {
    expect(shouldApplyTaskScheduleLoad({ kind: "schedule", scheduleId: "schedule-b" }, "schedule-b", 7, 7)).toBe(true);
    expect(shouldApplyTaskScheduleLoad({ kind: "schedule", scheduleId: "schedule-b" }, "schedule-a", 6, 7)).toBe(false);
    expect(shouldApplyTaskScheduleLoad({ kind: "schedule", scheduleId: "schedule-b" }, "schedule-b", 6, 7)).toBe(false);
    expect(shouldApplyTaskScheduleLoad({ kind: "detail", taskId: "task-b" }, "schedule-b", 7, 7)).toBe(false);
  });
});
