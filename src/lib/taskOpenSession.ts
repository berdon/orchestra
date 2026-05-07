import type { TaskDetail } from "../types";

export type TaskOpenSessionSource = "active_assignment" | "latest_lane_run";

export interface TaskOpenSessionTarget {
  sessionId: string;
  projectId?: string | null;
  source: TaskOpenSessionSource;
}

export function getTaskOpenSessionTarget(task: Pick<TaskDetail, "activeLaneAssignment" | "laneRuns" | "projectId">): TaskOpenSessionTarget | null {
  const activeAssignmentSessionId = task.activeLaneAssignment?.sessionId?.trim();
  if (activeAssignmentSessionId) {
    return {
      sessionId: activeAssignmentSessionId,
      projectId: task.projectId ?? null,
      source: "active_assignment",
    };
  }

  const latestLaneRunSessionId = [...task.laneRuns]
    .reverse()
    .find((laneRun) => laneRun.sessionId?.trim())
    ?.sessionId?.trim();
  if (!latestLaneRunSessionId) {
    return null;
  }

  return {
    sessionId: latestLaneRunSessionId,
    projectId: task.projectId ?? null,
    source: "latest_lane_run",
  };
}
