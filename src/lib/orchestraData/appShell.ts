import { useCallback, useEffect, useState } from "react";

import type { AgentSummary, MailboxMessage, ProjectSummary, RoleSummary, TaskSummary } from "../../types";
import { countVisibleUnreadTaskComments } from "../taskUnreadCommentVisibility";
import { useOrchestraClient } from "../orchestraClient";
import { useOrchestraEventSubscription } from "./events";

function countInboxUnreadThings(messages: MailboxMessage[], tasks: TaskSummary[]) {
  const unreadInboxMessages = messages.filter((message) => !message.readAt && !message.archivedAt).length;
  const approvalTasks = tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked).length;
  return unreadInboxMessages + approvalTasks;
}

function countUnreadTaskComments(tasks: TaskSummary[]) {
  return countVisibleUnreadTaskComments(tasks);
}

export function useProjectUnreadCounts(projects: ProjectSummary[], disabled = false) {
  const orchestraClient = useOrchestraClient();
  const [projectUnreadCounts, setProjectUnreadCounts] = useState<Record<string, number>>({});
  const [projectTaskCommentUnreadCounts, setProjectTaskCommentUnreadCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    if (disabled || projects.length === 0) {
      setProjectUnreadCounts({});
      setProjectTaskCommentUnreadCounts({});
      return;
    }

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
  }, [disabled, orchestraClient, projects]);

  useEffect(() => {
    void refresh().catch(() => {
      setProjectUnreadCounts({});
      setProjectTaskCommentUnreadCounts({});
    });
  }, [refresh]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "inbox.change" || event.kind === "task.change") {
      void refresh().catch(() => {
        setProjectUnreadCounts({});
        setProjectTaskCommentUnreadCounts({});
      });
    }
  }, { disabled });

  return {
    projectTaskCommentUnreadCounts,
    projectUnreadCounts,
    refresh,
  };
}

export function useProjectReferenceData(activeProjectId: string | null, disabled = false) {
  const orchestraClient = useOrchestraClient();
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

    const [tasks, agents, roles] = await Promise.all([
      orchestraClient.tasks.list({ includeArchived: false, projectId: activeProjectId }),
      orchestraClient.catalog.listAgents(false, activeProjectId),
      orchestraClient.catalog.listRoles(false),
    ]);
    setReferenceTasks(tasks);
    setReferenceAgents(agents);
    setReferenceRoles(roles);
  }, [activeProjectId, disabled, orchestraClient]);

  useEffect(() => {
    void refresh().catch(() => {
      setReferenceTasks([]);
      setReferenceAgents([]);
      setReferenceRoles([]);
    });
  }, [refresh]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "task.change") {
      void refresh().catch(() => {
        setReferenceTasks([]);
        setReferenceAgents([]);
        setReferenceRoles([]);
      });
    }
  }, { disabled });

  return {
    referenceAgents,
    referenceRoles,
    referenceTasks,
    refresh,
  };
}
