import { useCallback, useEffect, useState } from "react";

import type { AgentSummary, MailboxMessage, TaskSummary } from "../../types";
import { mergeInboxMessageUpdates, sortInboxMessages } from "../inboxMessages";
import type { OrchestraConnectionSnapshot } from "../orchestraClient";
import { retryOrchestraRead, useOrchestraClient } from "../orchestraClient";
import { useOrchestraConnection } from "./connection";
import { useOrchestraEventSubscription } from "./events";
import { reportUiError, type UiErrorState } from "./errors";
import { deriveOrchestraInitialLoadState, type OrchestraInitialLoadState } from "./resourceState";

interface UseInboxDataResult {
  agents: AgentSummary[];
  applyMessageUpdates: (updatedMessages: MailboxMessage[]) => void;
  connection: OrchestraConnectionSnapshot;
  error: UiErrorState | null;
  initialLoadState: OrchestraInitialLoadState;
  loading: boolean;
  messages: MailboxMessage[];
  refreshing: boolean;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  retry: () => Promise<void>;
  setError: (value: UiErrorState | null) => void;
  tasks: TaskSummary[];
}

export function useInboxData(projectId: string | null = null): UseInboxDataResult {
  const orchestraClient = useOrchestraClient();
  const connection = useOrchestraConnection();
  const [messages, setMessages] = useState<MailboxMessage[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<UiErrorState | null>(null);

  const applyMessageUpdates = useCallback((updatedMessages: MailboxMessage[]) => {
    setMessages((current) => mergeInboxMessageUpdates(current, updatedMessages));
  }, []);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const hasData = messages.length > 0 || tasks.length > 0 || agents.length > 0;
    if (options?.silent || hasData) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const [nextMessages, nextTasks, nextAgents] = await retryOrchestraRead(() => Promise.all([
        orchestraClient.inbox.list(projectId, true),
        orchestraClient.tasks.list({ includeArchived: false, projectId }),
        orchestraClient.catalog.listAgents(false, projectId),
      ]));
      setMessages(sortInboxMessages(nextMessages));
      setTasks(nextTasks);
      setAgents(nextAgents);
      setError(null);
    } catch (nextError) {
      setError(await reportUiError(orchestraClient, "ui.inbox.load", nextError, "Unable to load Inbox."));
      throw nextError;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agents.length, messages.length, orchestraClient, projectId, tasks.length]);

  const retry = useCallback(async () => {
    await refresh();
  }, [refresh]);

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
    applyMessageUpdates,
    connection,
    error,
    initialLoadState: deriveOrchestraInitialLoadState({
      loading,
      hasData: messages.length > 0 || tasks.length > 0 || agents.length > 0,
      error: Boolean(error),
    }),
    loading,
    messages,
    refreshing,
    refresh,
    retry,
    setError,
    tasks,
  };
}
