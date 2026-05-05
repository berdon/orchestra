import { useCallback, useEffect, useState } from "react";

import type { AgentSummary, MailboxMessage, ProjectSummary, RoleSummary, TaskSummary } from "../../types";
import { countVisibleUnreadTaskComments } from "../taskUnreadCommentVisibility";
import { useOrchestraClient } from "../orchestraClient";
import { useCoalescedRefresh } from "./coalescedRefresh";
import { useOrchestraEventSubscription } from "./events";

function countInboxUnreadThings(messages: MailboxMessage[], tasks: TaskSummary[]) {
  const unreadInboxMessages = messages.filter((message) => !message.readAt && !message.archivedAt).length;
  const approvalTasks = tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked).length;
  return unreadInboxMessages + approvalTasks;
}

function countUnreadTaskComments(tasks: TaskSummary[]) {
  return countVisibleUnreadTaskComments(tasks);
}

function logAppShellTiming(label: string | null | undefined, startedAt: number, details?: Record<string, unknown>) {
  if (!label || typeof performance === "undefined") {
    return;
  }

  console.info("[orchestra][startup.timing]", {
    stage: label,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    ...details,
  });
}

export function useProjectUnreadCounts(
  projects: ProjectSummary[],
  options?: { disabled?: boolean; timingLabel?: string | null },
) {
  const orchestraClient = useOrchestraClient();
  const disabled = options?.disabled ?? false;
  const timingLabel = options?.timingLabel ?? null;
  const [projectUnreadCounts, setProjectUnreadCounts] = useState<Record<string, number>>({});
  const [projectTaskCommentUnreadCounts, setProjectTaskCommentUnreadCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    if (disabled || projects.length === 0) {
      setProjectUnreadCounts({});
      setProjectTaskCommentUnreadCounts({});
      return;
    }

    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const projectUnreadData = await Promise.all(projects.map(async (project) => {
      const [messages, tasks] = await Promise.all([
        orchestraClient.inbox.list(project.id, true),
        orchestraClient.tasks.list({ includeArchived: false, projectId: project.id }),
      ]);
      return {
        projectId: project.id,
        inboxUnreadCount: countInboxUnreadThings(messages, tasks),
        taskCommentUnreadCount: countUnreadTaskComments(tasks),
      };
    }));

    setProjectUnreadCounts(Object.fromEntries(projectUnreadData.map((entry) => [entry.projectId, entry.inboxUnreadCount])));
    setProjectTaskCommentUnreadCounts(Object.fromEntries(projectUnreadData.map((entry) => [entry.projectId, entry.taskCommentUnreadCount])));
    logAppShellTiming(timingLabel, startedAt, { projectCount: projects.length });
  }, [disabled, orchestraClient, projects, timingLabel]);

  const requestRefresh = useCoalescedRefresh(refresh, {
    disabled,
    onError: () => {
      setProjectUnreadCounts({});
      setProjectTaskCommentUnreadCounts({});
    },
  });

  useEffect(() => {
    void refresh().catch(() => {
      setProjectUnreadCounts({});
      setProjectTaskCommentUnreadCounts({});
    });
  }, [refresh]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "inbox.change" || event.kind === "task.change") {
      requestRefresh();
    }
  }, { disabled });

  return {
    projectTaskCommentUnreadCounts,
    projectUnreadCounts,
    refresh,
  };
}

export function useProjectReferenceData(
  activeProjectId: string | null,
  options?: { disabled?: boolean; timingLabel?: string | null },
) {
  const orchestraClient = useOrchestraClient();
  const disabled = options?.disabled ?? false;
  const timingLabel = options?.timingLabel ?? null;
  const [referenceTasks, setReferenceTasks] = useState<TaskSummary[]>([]);
  const [referenceAgents, setReferenceAgents] = useState<AgentSummary[]>([]);
  const [referenceRoles, setReferenceRoles] = useState<RoleSummary[]>([]);

  const refresh = useCallback(async () => {
    if (disabled || !activeProjectId) {
      setReferenceTasks([]);
      setReferenceAgents([]);
      setReferenceRoles([]);
      return;
    }

    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const [tasks, agents, roles] = await Promise.all([
      orchestraClient.tasks.list({ includeArchived: false, projectId: activeProjectId }),
      orchestraClient.catalog.listAgents(false, activeProjectId),
      orchestraClient.catalog.listRoles(false),
    ]);
    setReferenceTasks(tasks);
    setReferenceAgents(agents);
    setReferenceRoles(roles);
    logAppShellTiming(timingLabel, startedAt, { activeProjectId, taskCount: tasks.length });
  }, [activeProjectId, disabled, orchestraClient, timingLabel]);

  const requestRefresh = useCoalescedRefresh(refresh, {
    disabled,
    onError: () => {
      setReferenceTasks([]);
      setReferenceAgents([]);
      setReferenceRoles([]);
    },
  });

  useEffect(() => {
    void refresh().catch(() => {
      setReferenceTasks([]);
      setReferenceAgents([]);
      setReferenceRoles([]);
    });
  }, [refresh]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "task.change") {
      requestRefresh();
    }
  }, { disabled });

  return {
    referenceAgents,
    referenceRoles,
    referenceTasks,
    refresh,
  };
}
