export type TaskReviewAssignmentStatus = "awaiting_user_approval" | "awaiting_user_intervention" | "paused_by_user";

export interface TaskReviewStateInput {
  status: string;
  assigneeType?: string | null;
  currentLaneId?: string | null;
  activeLaneAssignment?: {
    status: string;
    pendingOutcome?: string | null;
  } | null;
}

export function isTaskInUserReviewState(task: TaskReviewStateInput) {
  return task.status === "in_review" && task.assigneeType === "user" && Boolean(task.currentLaneId);
}

export function getDerivedTaskReviewAssignmentStatus(task: TaskReviewStateInput): TaskReviewAssignmentStatus | null {
  const assignment = task.activeLaneAssignment;
  if (!assignment) {
    return null;
  }

  if (isTaskInUserReviewState(task)) {
    if (assignment.pendingOutcome === "success") {
      return "awaiting_user_approval";
    }
    if (assignment.pendingOutcome === "needs_user") {
      return "awaiting_user_intervention";
    }
    if (assignment.pendingOutcome === "paused") {
      return "paused_by_user";
    }
  }

  if (["awaiting_user_approval", "awaiting_user_intervention", "paused_by_user"].includes(assignment.status)) {
    return assignment.status as TaskReviewAssignmentStatus;
  }

  return null;
}

export function getEffectiveTaskReviewAssignmentStatus(task: TaskReviewStateInput): string | null {
  return getDerivedTaskReviewAssignmentStatus(task) ?? task.activeLaneAssignment?.status ?? null;
}

export function isTaskAwaitingUserApproval(task: TaskReviewStateInput) {
  return getEffectiveTaskReviewAssignmentStatus(task) === "awaiting_user_approval";
}

export function isTaskAwaitingUserIntervention(task: TaskReviewStateInput) {
  return getEffectiveTaskReviewAssignmentStatus(task) === "awaiting_user_intervention";
}
