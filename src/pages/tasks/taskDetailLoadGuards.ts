export type TaskDetailRouteState =
  | { kind: "overview" }
  | { kind: "create" }
  | { kind: "detail"; taskId: string }
  | { kind: "schedule"; scheduleId: string };

export type TaskDetailRenderState = "detail" | "detail_pending" | "loading" | null;

export function shouldApplyTaskDetailLoad(
  route: TaskDetailRouteState,
  taskId: string,
  requestId: number,
  latestRequestId: number,
) {
  return requestId === latestRequestId && route.kind === "detail" && route.taskId === taskId;
}

export function shouldApplyTaskScheduleLoad(
  route: TaskDetailRouteState,
  scheduleId: string,
  requestId: number,
  latestRequestId: number,
) {
  return requestId === latestRequestId && route.kind === "schedule" && route.scheduleId === scheduleId;
}

export function getTaskDetailRenderState(
  route: TaskDetailRouteState,
  taskDetailId: string | null,
  loading: boolean,
): TaskDetailRenderState {
  if (route.kind !== "detail") {
    return null;
  }

  if (!taskDetailId) {
    return "loading";
  }

  if (taskDetailId === route.taskId) {
    return "detail";
  }

  return loading ? "detail_pending" : "loading";
}
