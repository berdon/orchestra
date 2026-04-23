import { useCallback, useEffect } from "react";

import type { SessionStreamEnvelope } from "../../types";
import { useOrchestraClient } from "../orchestraClient";
import { useOrchestraEventSubscription } from "./events";

const TASK_EVENT_TOOL_NAMES = new Set([
  "create_task",
  "create_subtask",
  "add_task_todo",
  "mark_task_todo_finished",
  "mark_task_todo_unfinished",
  "delete_task_todo",
  "update_task",
  "comment_on_task",
  "dispatch_task_lane",
  "complete_lane_as_success",
  "complete_lane_as_failure",
  "request_user_intervention",
  "reassign_task_to_lane",
  "add_task_dependency",
  "remove_task_dependency",
  "add_task_attachment",
  "remove_task_attachment",
]);

function getSessionEventType(payload: SessionStreamEnvelope) {
  if (payload.event && typeof payload.event === "object" && !Array.isArray(payload.event) && "type" in payload.event) {
    const value = payload.event.type;
    return typeof value === "string" ? value : "";
  }

  return "";
}

function shouldRefreshTasksFromSessionEvent(payload: SessionStreamEnvelope) {
  const eventType = getSessionEventType(payload);
  if (eventType === "tool_execution_end") {
    const toolName = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event) && "toolName" in payload.event
      ? payload.event.toolName
      : null;
    return typeof toolName === "string" && TASK_EVENT_TOOL_NAMES.has(toolName);
  }

  return false;
}

interface UseTaskAutoRefreshOptions {
  disabled?: boolean;
  selectedTaskId?: string | null;
  selectedScheduleId?: string | null;
  canRefreshSelectedTask: boolean;
  canRefreshSelectedSchedule: boolean;
  refreshTasks: () => void;
  refreshTaskDetail: (taskId: string) => void;
  refreshTaskSchedule: (scheduleId: string) => void;
}

export function useTaskAutoRefresh({
  disabled = false,
  selectedTaskId = null,
  selectedScheduleId = null,
  canRefreshSelectedTask,
  canRefreshSelectedSchedule,
  refreshTasks,
  refreshTaskDetail,
  refreshTaskSchedule,
}: UseTaskAutoRefreshOptions) {
  const refresh = useCallback(() => {
    if (document.visibilityState !== "visible") {
      return;
    }

    refreshTasks();
    if (selectedTaskId && canRefreshSelectedTask) {
      refreshTaskDetail(selectedTaskId);
    }
    if (selectedScheduleId && canRefreshSelectedSchedule) {
      refreshTaskSchedule(selectedScheduleId);
    }
  }, [canRefreshSelectedSchedule, canRefreshSelectedTask, refreshTaskDetail, refreshTaskSchedule, refreshTasks, selectedScheduleId, selectedTaskId]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "task.change") {
      if (event.taskIds.length === 0 || !selectedTaskId || event.taskIds.includes(selectedTaskId)) {
        refresh();
        return;
      }
      refresh();
      return;
    }

    if (event.kind === "session.stream" && shouldRefreshTasksFromSessionEvent(event)) {
      refresh();
    }
  }, { disabled });

  useEffect(() => {
    if (disabled) {
      return;
    }

    const intervalId = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [disabled, refresh]);
}

export function useTaskCommentFileMentions(taskId: string) {
  const orchestraClient = useOrchestraClient();

  return useCallback(async (query: string, limit = 12) => {
    if (!taskId) {
      return [];
    }
    return orchestraClient.tasks.searchCommentFileMentions(taskId, query, limit);
  }, [orchestraClient, taskId]);
}

export function useTaskFileContent() {
  const orchestraClient = useOrchestraClient();

  return useCallback(async (path: string) => {
    if (!path) {
      return null;
    }
    return orchestraClient.tasks.getFileContent(path);
  }, [orchestraClient]);
}
