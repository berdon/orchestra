import type { TaskComment } from "../types";

export interface TaskCommentThread {
  comment: TaskComment;
  replies: TaskComment[];
  latestActivityAt: string;
}

function sortCommentsByCreatedAtAscending(left: TaskComment, right: TaskComment) {
  const createdOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdOrder !== 0) {
    return createdOrder;
  }
  return left.id.localeCompare(right.id);
}

export function buildTaskCommentThreads(comments: TaskComment[]): TaskCommentThread[] {
  const repliesByParent = new Map<string, TaskComment[]>();
  const topLevelComments: TaskComment[] = [];

  for (const comment of comments) {
    if (!comment.parentCommentId) {
      topLevelComments.push(comment);
      continue;
    }

    const replies = repliesByParent.get(comment.parentCommentId) ?? [];
    replies.push(comment);
    repliesByParent.set(comment.parentCommentId, replies);
  }

  return topLevelComments.map((comment) => {
    const replies = (repliesByParent.get(comment.id) ?? []).slice().sort(sortCommentsByCreatedAtAscending);
    const latestActivityAt = replies.reduce(
      (latest, reply) => (reply.updatedAt.localeCompare(latest) > 0 ? reply.updatedAt : latest),
      comment.updatedAt,
    );

    return {
      comment,
      replies,
      latestActivityAt,
    };
  });
}

export function sortTaskCommentThreadsByLatestActivityDesc(threads: TaskCommentThread[]) {
  return threads.slice().sort((left, right) => {
    const activityOrder = right.latestActivityAt.localeCompare(left.latestActivityAt);
    if (activityOrder !== 0) {
      return activityOrder;
    }

    const createdOrder = right.comment.createdAt.localeCompare(left.comment.createdAt);
    if (createdOrder !== 0) {
      return createdOrder;
    }

    return right.comment.id.localeCompare(left.comment.id);
  });
}
