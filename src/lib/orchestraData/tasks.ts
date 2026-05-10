import { useCallback, useEffect } from "react";

import { useOrchestraClient } from "../orchestraClient";
import { useCoalescedRefresh } from "./coalescedRefresh";
import { useOrchestraEventSubscription } from "./events";

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

  const requestRefresh = useCoalescedRefresh(refresh, { disabled });

  useOrchestraEventSubscription((event) => {
    if (event.kind === "task.change") {
      requestRefresh();
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

export function useTaskCommentFileMentions(taskId?: string | null) {
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

export function useTaskAttachmentContent() {
  const orchestraClient = useOrchestraClient();

  return useCallback(async (attachmentId: string) => {
    if (!attachmentId) {
      return null;
    }
    if (!orchestraClient.tasks.getAttachmentContent) {
      throw new Error("Task attachment viewing is unavailable in this host.");
    }
    return orchestraClient.tasks.getAttachmentContent(attachmentId);
  }, [orchestraClient]);
}
