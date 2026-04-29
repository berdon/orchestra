import {
  getEffectiveTaskReviewAssignmentStatus,
  isTaskAwaitingUserApproval,
  isTaskAwaitingUserIntervention,
  type TaskReviewStateInput,
} from "../../lib/taskReviewState";

type TaskDetailActionStateInput = TaskReviewStateInput;

export function getEffectiveTaskDetailAssignmentStatus(task: TaskDetailActionStateInput): string | null {
  return getEffectiveTaskReviewAssignmentStatus(task);
}

export function isTaskDetailAwaitingUserApproval(task: TaskDetailActionStateInput) {
  return isTaskAwaitingUserApproval(task);
}

export function isTaskDetailAwaitingUserIntervention(task: TaskDetailActionStateInput) {
  return isTaskAwaitingUserIntervention(task);
}
