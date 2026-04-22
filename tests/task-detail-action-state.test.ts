import { describe, expect, it } from "vitest";

import { getEffectiveTaskDetailAssignmentStatus } from "../src/pages/tasks/taskDetailActionState";

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    status: "in_progress",
    assigneeType: "role",
    currentLaneId: "lane-work",
    activeLaneAssignment: {
      status: "active",
      pendingOutcome: null,
    },
    ...overrides,
  } as any;
}

describe("task detail action state", () => {
  it("keeps active worker lanes actionable as pauseable work", () => {
    expect(getEffectiveTaskDetailAssignmentStatus(buildTask())).toBe("active");
    expect(getEffectiveTaskDetailAssignmentStatus(buildTask({ activeLaneAssignment: { status: "queued", pendingOutcome: null } }))).toBe("queued");
  });

  it("treats review-paused success work as awaiting approval even if the assignment status lags", () => {
    expect(
      getEffectiveTaskDetailAssignmentStatus(
        buildTask({
          status: "in_review",
          assigneeType: "user",
          activeLaneAssignment: {
            status: "active",
            pendingOutcome: "success",
          },
        }),
      ),
    ).toBe("awaiting_user_approval");
  });

  it("treats review-paused intervention work as awaiting user intervention even if the assignment status lags", () => {
    expect(
      getEffectiveTaskDetailAssignmentStatus(
        buildTask({
          status: "in_review",
          assigneeType: "user",
          activeLaneAssignment: {
            status: "active",
            pendingOutcome: "needs_user",
          },
        }),
      ),
    ).toBe("awaiting_user_intervention");
  });

  it("preserves explicit paused statuses from the task detail payload", () => {
    expect(
      getEffectiveTaskDetailAssignmentStatus(
        buildTask({ activeLaneAssignment: { status: "awaiting_user_approval", pendingOutcome: null } }),
      ),
    ).toBe("awaiting_user_approval");
    expect(
      getEffectiveTaskDetailAssignmentStatus(
        buildTask({ activeLaneAssignment: { status: "paused_by_user", pendingOutcome: "paused" } }),
      ),
    ).toBe("paused_by_user");
  });
});
