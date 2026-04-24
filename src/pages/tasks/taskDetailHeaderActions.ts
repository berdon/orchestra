import type { TaskActionMenuAction } from "../../components/TaskActionMenu";
import type { TaskDetail } from "../../types";

type TaskDetailHeaderActionTask = Pick<TaskDetail, "status" | "assigneeType" | "currentLaneId" | "activeLaneAssignment">;

interface BuildTaskDetailHeaderActionsInput {
  task: TaskDetailHeaderActionTask;
  canPublish: boolean;
  effectiveActiveLaneAssignmentStatus: string | null;
  onPublish: () => void;
  onDispatch: () => void;
  onApproveCompletion: () => void;
  onSendBackForWork: () => void;
  onResetTask: () => void;
  onComplete: (outcome: "success" | "failure") => void;
  onPauseRuntime: () => void;
  onWhipTask: () => void;
}

export function buildTaskDetailHeaderActions({
  task,
  canPublish,
  effectiveActiveLaneAssignmentStatus,
  onPublish,
  onDispatch,
  onApproveCompletion,
  onSendBackForWork,
  onResetTask,
  onComplete,
  onPauseRuntime,
  onWhipTask,
}: BuildTaskDetailHeaderActionsInput): TaskActionMenuAction[] {
  const actions: TaskActionMenuAction[] = [];

  if (task.status === "draft") {
    actions.push({
      id: "publish",
      label: "Dispatch",
      onClick: onPublish,
      disabled: !canPublish,
      variant: "primary",
      dataRole: "publish-task",
      tooltip: "Save this draft and move it into workflow execution.",
    });
  } else if (task.status === "ready") {
    actions.push({
      id: "dispatch-ready",
      label: "Dispatch",
      onClick: onDispatch,
      variant: "primary",
      dataRole: "dispatch-task-lane",
      tooltip: "Start the current workflow lane for this ready task.",
    });
  }

  if (effectiveActiveLaneAssignmentStatus === "awaiting_user_approval") {
    actions.push({
      id: "approve-pending",
      label: "Approve",
      onClick: onApproveCompletion,
      variant: "primary",
      dataRole: "approve-task-lane",
      tooltip: "Accept this lane result and let the workflow continue.",
    });
    actions.push({
      id: "needs-work-pending",
      label: "Needs work",
      onClick: onSendBackForWork,
      variant: "secondary",
      dataRole: "send-task-back-for-work",
      tooltip: "Send this lane back for more work without closing the task.",
    });
    actions.push({
      id: "stop-pending-review",
      label: "Stop",
      onClick: onResetTask,
      variant: "secondary",
      dataRole: "stop-task-activity",
      tooltip: "End the current assignment and return this task to a ready state.",
    });
  } else if (["awaiting_user_intervention", "paused_by_user"].includes(effectiveActiveLaneAssignmentStatus ?? "")) {
    actions.push({
      id: "resume-pending",
      label: "Resume",
      onClick: onSendBackForWork,
      variant: "primary",
      dataRole: "resume-task-lane",
      tooltip: "Resume the paused lane and keep work moving in the same assignment.",
    });
    actions.push({
      id: "stop-paused-lane",
      label: "Stop",
      onClick: onResetTask,
      variant: "secondary",
      dataRole: "stop-task-activity",
      tooltip: "End the paused assignment and return this task to a ready state.",
    });
  } else if (task.status === "in_review" && !task.activeLaneAssignment && task.assigneeType === "user" && task.currentLaneId) {
    actions.push({
      id: "approve-user",
      label: "Approve",
      onClick: () => onComplete("success"),
      variant: "primary",
      dataRole: "complete-task-success",
      tooltip: "Mark this review step successful and continue the workflow.",
    });
    actions.push({
      id: "needs-work-user",
      label: "Needs work",
      onClick: () => onComplete("failure"),
      variant: "secondary",
      dataRole: "complete-task-failure",
      tooltip: "Send this review step back as incomplete so more work can happen.",
    });
  }

  if (["active", "queued"].includes(effectiveActiveLaneAssignmentStatus ?? "")) {
    actions.push({
      id: "pause",
      label: "Pause",
      onClick: onPauseRuntime,
      variant: "secondary",
      dataRole: "pause-task-runtime",
      tooltip: "Pause the active lane without clearing its current assignment.",
    });
    actions.push({
      id: "stop-active-work",
      label: "Stop",
      onClick: onResetTask,
      variant: "secondary",
      dataRole: "stop-task-activity",
      tooltip: "End the current assignment and return this task to a ready state.",
    });
  }

  if (task.status !== "draft" && task.status !== "ready" && task.activeLaneAssignment) {
    actions.push({
      id: "whip",
      label: "Whip",
      onClick: onWhipTask,
      variant: "secondary",
      dataRole: "whip-task-runtime",
      tooltip: "Send a fresh nudge so the active worker keeps making progress on this lane.",
    });
  }

  return actions;
}
