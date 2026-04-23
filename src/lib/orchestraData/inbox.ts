import { useCallback, useEffect, useState } from "react";

import type { AgentSummary, MailboxMessage, TaskSummary } from "../../types";
import { useOrchestraClient } from "../orchestraClient";
import { useOrchestraEventSubscription } from "./events";

interface UseInboxDataResult {
  agents: AgentSummary[];
  error: string | null;
  loading: boolean;
  messages: MailboxMessage[];
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  setError: (value: string | null) => void;
  tasks: TaskSummary[];
}

export function useInboxData(projectId: string | null = null): UseInboxDataResult {
  const orchestraClient = useOrchestraClient();
  const [messages, setMessages] = useState<MailboxMessage[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }

    try {
      const [nextMessages, nextTasks, nextAgents] = await Promise.all([
        orchestraClient.inbox.list(projectId, true),
        orchestraClient.tasks.list({ includeArchived: false, projectId }),
        orchestraClient.catalog.listAgents(false, projectId),
      ]);
      setMessages(nextMessages);
      setTasks(nextTasks);
      setAgents(nextAgents);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load Inbox.");
      throw nextError;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [orchestraClient, projectId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useOrchestraEventSubscription((event) => {
    if (event.kind === "inbox.change" || event.kind === "task.change") {
      void refresh({ silent: true }).catch(() => undefined);
    }
  });

  return {
    agents,
    error,
    loading,
    messages,
    refresh,
    setError,
    tasks,
  };
}
