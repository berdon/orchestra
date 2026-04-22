import type { TaskSummary } from "../types";

export type TaskUnreadCommentAttentionTask = Pick<TaskSummary, "status" | "unreadCommentCount">;

const TERMINAL_UNREAD_HIDDEN_STATUSES = new Set(["completed", "canceled"]);

export function shouldShowUnreadCommentAttention(task: TaskUnreadCommentAttentionTask) {
  return task.unreadCommentCount > 0 && !TERMINAL_UNREAD_HIDDEN_STATUSES.has(task.status);
}

export function countVisibleUnreadTaskComments(tasks: TaskUnreadCommentAttentionTask[]) {
  return tasks.reduce((total, task) => total + (shouldShowUnreadCommentAttention(task) ? task.unreadCommentCount : 0), 0);
}
