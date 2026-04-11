export type TaskDetailRouteState =
  | { kind: "overview" }
  | { kind: "create" }
  | { kind: "detail"; taskId: string }
  | { kind: "schedule"; scheduleId: string };

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
