import type { TaskDetail } from "../../types";

type TaskDetailActionStateInput = Pick<TaskDetail, "status" | "assigneeType" | "currentLaneId" | "activeLaneAssignment">;

function isUserReviewState(task: TaskDetailActionStateInput) {
  return task.status === "in_review" && task.assigneeType === "user" && Boolean(task.currentLaneId);
}

export function getEffectiveTaskDetailAssignmentStatus(task: TaskDetailActionStateInput): string | null {
  const assignment = task.activeLaneAssignment;
  if (!assignment) {
    return null;
  }

  if (["awaiting_user_approval", "awaiting_user_intervention", "paused_by_user"].includes(assignment.status)) {
    return assignment.status;
  }

  if (isUserReviewState(task)) {
    if (assignment.pendingOutcome === "success") {
      return "awaiting_user_approval";
    }
    if (assignment.pendingOutcome === "needs_user") {
      return "awaiting_user_intervention";
    }
  }

  return assignment.status;
}

export function isTaskDetailAwaitingUserApproval(task: TaskDetailActionStateInput) {
  return getEffectiveTaskDetailAssignmentStatus(task) === "awaiting_user_approval";
}

export function isTaskDetailAwaitingUserIntervention(task: TaskDetailActionStateInput) {
  return getEffectiveTaskDetailAssignmentStatus(task) === "awaiting_user_intervention";
}
