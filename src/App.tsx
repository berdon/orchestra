import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveWorkflow,
  createSession,
  createWorkflow,
  duplicateWorkflow,
  getAppInfo,
  getLogs,
  getSessionModelState,
  getWorkflow,
  isTauriAvailable,
  listSessions,
  listWorkflows,
  listenToSessionStream,
  resumeSession,
  sendSessionMessage,
  setSessionModel,
  subscribeSession,
  unsubscribeSession,
  updateWorkflow,
  validateWorkflow,
} from "./lib/tauri";
import type {
  AppInfo,
  LogEntry,
  PrimaryPage,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionStatus,
  SessionStreamEvent,
  WorkflowDefinition,
  WorkflowLaneInput,
  WorkflowSummary,
  WorkflowUpsertInput,
  WorkflowValidationError,
} from "./types";

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

const PAGE_COPY: Record<Exclude<PrimaryPage, "sessions" | "settings">, { eyebrow: string; title: string; body: string }> = {
  tasks: {
    eyebrow: "Workflow operations",
    title: "Tasks",
    body: "Task and workflow management will land after the session-first slice is proven end to end.",
  },
  agents: {
    eyebrow: "Workforce overview",
    title: "Agents",
    body: "Agents and roles will share an operational view focused on workload, queues, active sessions, and intervention pressure.",
  },
};

const SETTINGS_TABS = [
  { id: "workflows", label: "Workflows" },
  { id: "logs", label: "Logs" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

interface PendingSessionRun {
  runId: string;
  userEvent: SessionEvent;
  assistantEvent?: SessionEvent;
}

function createClientId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusTone(status: SessionStatus) {
  switch (status) {
    case "active":
    case "streaming":
      return "success";
    case "paused":
      return "warning";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

function getEventTone(kind: SessionEvent["kind"]) {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    default:
      return "system";
  }
}

function formatModelOptionLabel(modelState: SessionModelState | undefined) {
  if (!modelState) {
    return "Loading models…";
  }

  if (modelState.currentModel) {
    return `${modelState.currentModel.name} · ${modelState.currentModel.provider}`;
  }

  return "Choose a model";
}

function createEmptyLane(order: number): WorkflowLaneInput {
  return {
    id: `lane-${Math.random().toString(36).slice(2, 8)}`,
    key: "",
    name: "",
    order,
    assignedEntityType: "user",
    assignedEntityId: null,
    entryPromptTemplate: null,
    successTargetLaneId: null,
    failureTargetLaneId: null,
    userInterventionTargetLaneId: null,
  };
}

function createBlankWorkflowDraft(): WorkflowUpsertInput {
  return {
    name: "",
    description: "",
    lanes: [createEmptyLane(0)],
  };
}

function workflowToDraft(workflow: WorkflowDefinition): WorkflowUpsertInput {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    lanes: workflow.lanes
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((lane, index) => ({
        id: lane.id,
        key: lane.key,
        name: lane.name,
        description: lane.description ?? "",
        order: index,
        assignedEntityType: lane.assignedEntityType,
        assignedEntityId: lane.assignedEntityId ?? "",
        entryPromptTemplate: lane.entryPromptTemplate ?? "",
        successTargetLaneId: lane.successTargetLaneId ?? "",
        failureTargetLaneId: lane.failureTargetLaneId ?? "",
        userInterventionTargetLaneId: lane.userInterventionTargetLaneId ?? "",
      })),
  };
}

function getWorkflowValidationForPath(errors: WorkflowValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

export function App() {
  const [activePage, setActivePage] = useState<PrimaryPage>("sessions");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("workflows");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingSessionRun>>({});
  const [modelStates, setModelStates] = useState<Record<string, SessionModelState>>({});
  const [loadingModelSessionId, setLoadingModelSessionId] = useState<string | null>(null);
  const [changingModelSessionId, setChangingModelSessionId] = useState<string | null>(null);

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowUpsertInput>(createBlankWorkflowDraft);
  const [workflowValidation, setWorkflowValidation] = useState<WorkflowValidationError[]>([]);
  const [workflowActionError, setWorkflowActionError] = useState<string | null>(null);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [loadingWorkflowDetail, setLoadingWorkflowDetail] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [includeArchivedWorkflows, setIncludeArchivedWorkflows] = useState(false);
  const [isCreatingWorkflow, setIsCreatingWorkflow] = useState(false);
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | null>(null);
  const [loadedWorkflowArchived, setLoadedWorkflowArchived] = useState(false);

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null,
    [selectedSessionId, sessions],
  );

  const selectedWorkflowSummary = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0] ?? null,
    [selectedWorkflowId, workflows],
  );

  const selectedSessionPendingRun = selectedSession ? pendingRuns[selectedSession.id] : undefined;
  const selectedModelState = selectedSession ? modelStates[selectedSession.id] : undefined;

  const displayedEvents = useMemo(() => {
    if (!selectedSession) {
      return [];
    }

    const pendingRun = pendingRuns[selectedSession.id];
    if (!pendingRun) {
      return selectedSession.events;
    }

    return [
      ...selectedSession.events,
      pendingRun.userEvent,
      ...(pendingRun.assistantEvent ? [pendingRun.assistantEvent] : []),
    ];
  }, [pendingRuns, selectedSession]);

  const activeSessionCount = useMemo(() => {
    const alreadyActive = new Set(sessions.filter((session) => session.status === "active").map((session) => session.id));
    return sessions.filter((session) => session.status === "active").length + Object.keys(pendingRuns).filter((id) => !alreadyActive.has(id)).length;
  }, [pendingRuns, sessions]);

  const subscribedSessionCount = useMemo(() => sessions.filter((session) => session.subscribed).length, [sessions]);

  const laneIdOptions = useMemo(
    () => workflowDraft.lanes.map((lane) => ({ id: lane.id ?? "", label: lane.name.trim() || lane.key.trim() || lane.id || "Unnamed lane" })),
    [workflowDraft.lanes],
  );

  const validationSummary = useMemo(() => workflowValidation.map((error) => `${error.path}: ${error.message}`), [workflowValidation]);

  const applySessionUpdate = useCallback((updatedSession: SessionRecord) => {
    setSessions((current) => {
      const withoutOld = current.filter((session) => session.id !== updatedSession.id);
      return [updatedSession, ...withoutOld].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    });
    setSelectedSessionId(updatedSession.id);
  }, []);

  const removePendingRun = useCallback((sessionId: string, runId?: string) => {
    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing || (runId && existing.runId !== runId)) {
        return current;
      }

      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const updatePendingRun = useCallback((sessionId: string, updater: (run: PendingSessionRun) => PendingSessionRun) => {
    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [sessionId]: updater(existing),
      };
    });
  }, []);

  async function loadLogs() {
    setLoadingLogs(true);
    try {
      setLogs(await getLogs());
    } finally {
      setLoadingLogs(false);
    }
  }

  async function loadSessions() {
    setLoadingSessions(true);
    setSessionActionError(null);

    try {
      const nextSessions = await listSessions();
      setSessions(nextSessions);
      setSelectedSessionId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }

        return nextSessions[0]?.id ?? null;
      });
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to load sessions.");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadWorkflows() {
    setLoadingWorkflows(true);
    setWorkflowActionError(null);

    try {
      const nextWorkflows = await listWorkflows(includeArchivedWorkflows);
      setWorkflows(nextWorkflows);
      setSelectedWorkflowId((current) => {
        if (isCreatingWorkflow) {
          return current;
        }

        if (current && nextWorkflows.some((workflow) => workflow.id === current)) {
          return current;
        }

        return nextWorkflows[0]?.id ?? null;
      });
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to load workflows.");
    } finally {
      setLoadingWorkflows(false);
    }
  }

  async function loadWorkflowDetail(workflowId: string) {
    setLoadingWorkflowDetail(true);
    setWorkflowActionError(null);

    try {
      const workflow = await getWorkflow(workflowId);
      setWorkflowDraft(workflowToDraft(workflow));
      setWorkflowValidation([]);
      setLoadedWorkflowId(workflow.id);
      setLoadedWorkflowArchived(workflow.archived);
      setIsCreatingWorkflow(false);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to load workflow.");
    } finally {
      setLoadingWorkflowDetail(false);
    }
  }

  async function runSessionAction(action: () => Promise<SessionRecord>) {
    setIsSubmitting(true);
    setSessionActionError(null);

    try {
      const updatedSession = await action();
      applySessionUpdate(updatedSession);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Session action failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleSessionStreamEvent = useCallback(
    (payload: SessionStreamEvent) => {
      switch (payload.event) {
        case "assistantStart": {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            assistantEvent: current.assistantEvent ?? {
              id: `pending-assistant-${payload.runId}`,
              kind: "assistant",
              message: "",
              timestamp: payload.timestamp ?? nowIso(),
              pending: true,
              runId: payload.runId,
            },
          }));
          break;
        }
        case "assistantDelta": {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            assistantEvent: {
              id: current.assistantEvent?.id ?? `pending-assistant-${payload.runId}`,
              kind: "assistant",
              message: `${current.assistantEvent?.message ?? ""}${payload.delta ?? ""}`,
              timestamp: current.assistantEvent?.timestamp ?? payload.timestamp ?? nowIso(),
              pending: true,
              runId: payload.runId,
            },
          }));
          break;
        }
        case "sessionUpdated": {
          if (payload.record) {
            applySessionUpdate(payload.record);
          }
          removePendingRun(payload.sessionId, payload.runId);
          break;
        }
        case "error": {
          removePendingRun(payload.sessionId, payload.runId);
          setSessionActionError(payload.message ?? "Session action failed.");
          break;
        }
        default:
          break;
      }
    },
    [applySessionUpdate, removePendingRun, updatePendingRun],
  );

  useEffect(() => {
    void getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    if (!isTauriAvailable()) {
      void listenToSessionStream(handleSessionStreamEvent).then((dispose) => {
        unlisten = dispose;
      });
      return () => {
        unlisten?.();
      };
    }

    void listenToSessionStream(handleSessionStreamEvent).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [handleSessionStreamEvent]);

  useEffect(() => {
    if (activePage === "settings") {
      if (settingsTab === "logs") {
        void loadLogs();
      } else {
        void loadWorkflows();
      }
      return;
    }

    if (activePage === "sessions") {
      void loadSessions();
    }
  }, [activePage, settingsTab, includeArchivedWorkflows]);

  useEffect(() => {
    if (activePage !== "settings" || settingsTab !== "workflows" || isCreatingWorkflow) {
      return;
    }

    const workflowId = selectedWorkflowSummary?.id;
    if (!workflowId || workflowId === loadedWorkflowId) {
      return;
    }

    void loadWorkflowDetail(workflowId);
  }, [activePage, settingsTab, selectedWorkflowSummary?.id, isCreatingWorkflow, loadedWorkflowId]);

  useEffect(() => {
    if (activePage !== "sessions" || !selectedSession) {
      return;
    }

    let cancelled = false;
    setLoadingModelSessionId(selectedSession.id);

    void getSessionModelState(selectedSession.id)
      .then((state) => {
        if (cancelled) {
          return;
        }

        setModelStates((current) => ({
          ...current,
          [state.sessionId]: state,
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionActionError(error instanceof Error ? error.message : "Unable to load session model.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModelSessionId((current) => (current === selectedSession.id ? null : current));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePage, selectedSession?.id]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [displayedEvents, selectedSession?.id]);

  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);
  const selectedSessionDisplayStatus: SessionStatus = selectedSessionPendingRun ? "streaming" : selectedSession?.status ?? "idle";
  const selectedSessionBusy = Boolean(selectedSessionPendingRun) || isSubmitting;

  async function handleModelChange(value: string) {
    if (!selectedSession) {
      return;
    }

    const [provider, ...modelParts] = value.split("/");
    const modelId = modelParts.join("/");
    if (!provider || !modelId) {
      return;
    }

    setSessionActionError(null);
    setChangingModelSessionId(selectedSession.id);

    try {
      const state = await setSessionModel(selectedSession.id, provider, modelId);
      setModelStates((current) => ({
        ...current,
        [state.sessionId]: state,
      }));
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to change models.");
    } finally {
      setChangingModelSessionId((current) => (current === selectedSession.id ? null : current));
    }
  }

  function handleSendMessage() {
    if (!selectedSession) {
      return;
    }

    const trimmedMessage = draftMessage.trim();
    if (!trimmedMessage || pendingRuns[selectedSession.id]) {
      return;
    }

    const runId = createClientId("run");
    const timestamp = nowIso();
    const sessionId = selectedSession.id;

    setSessionActionError(null);
    setDraftMessage("");
    setPendingRuns((current) => ({
      ...current,
      [sessionId]: {
        runId,
        userEvent: {
          id: `pending-user-${runId}`,
          kind: "user",
          message: trimmedMessage,
          timestamp,
          pending: true,
          runId,
        },
      },
    }));

    void sendSessionMessage(sessionId, trimmedMessage, runId).catch((error) => {
      removePendingRun(sessionId, runId);
      setDraftMessage((current) => (current.length === 0 ? trimmedMessage : current));
      setSessionActionError(error instanceof Error ? error.message : "Unable to queue message.");
    });
  }

  async function refreshWorkflowValidation(nextDraft: WorkflowUpsertInput) {
    try {
      const validation = await validateWorkflow(nextDraft);
      setWorkflowValidation(validation.errors);
      return validation.errors;
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to validate workflow.");
      return [];
    }
  }

  function updateWorkflowDraft(updater: (draft: WorkflowUpsertInput) => WorkflowUpsertInput) {
    setWorkflowDraft((current) => {
      const next = updater(current);
      void refreshWorkflowValidation(next);
      return next;
    });
  }

  function beginCreateWorkflow() {
    setSelectedWorkflowId(null);
    setWorkflowDraft(createBlankWorkflowDraft());
    setWorkflowValidation([]);
    setWorkflowActionError(null);
    setLoadedWorkflowId(null);
    setLoadedWorkflowArchived(false);
    setIsCreatingWorkflow(true);
  }

  async function handleSaveWorkflow() {
    setSavingWorkflow(true);
    setWorkflowActionError(null);

    try {
      const validation = await validateWorkflow(workflowDraft);
      setWorkflowValidation(validation.errors);
      if (!validation.valid) {
        setWorkflowActionError("Fix the workflow validation errors before saving.");
        return;
      }

      const saved = loadedWorkflowId && !isCreatingWorkflow
        ? await updateWorkflow(loadedWorkflowId, workflowDraft)
        : await createWorkflow(workflowDraft);

      await loadWorkflows();
      setSelectedWorkflowId(saved.id);
      setLoadedWorkflowId(saved.id);
      setLoadedWorkflowArchived(saved.archived);
      setWorkflowDraft(workflowToDraft(saved));
      setWorkflowValidation([]);
      setIsCreatingWorkflow(false);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to save workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function handleDuplicateWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setSavingWorkflow(true);
    setWorkflowActionError(null);
    try {
      const duplicated = await duplicateWorkflow(selectedWorkflowSummary.id);
      await loadWorkflows();
      setSelectedWorkflowId(duplicated.id);
      await loadWorkflowDetail(duplicated.id);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to duplicate workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function handleArchiveWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setSavingWorkflow(true);
    setWorkflowActionError(null);
    try {
      const archived = await archiveWorkflow(selectedWorkflowSummary.id);
      await loadWorkflows();
      setSelectedWorkflowId(archived.id);
      await loadWorkflowDetail(archived.id);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to archive workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="project-switcher">
            <span className="project-switcher__label">Project</span>
            <button className="project-switcher__button" type="button">
              Orchestra <span aria-hidden="true">▾</span>
            </button>
          </div>

          <nav className="primary-nav" aria-label="Primary">
            {activeNavItems.map((item) => (
              <button
                key={item.id}
                className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                type="button"
                onClick={() => setActivePage(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar__bottom">
          <button
            className={activePage === "settings" ? "nav-item nav-item--active" : "nav-item"}
            type="button"
            onClick={() => setActivePage("settings")}
          >
            Settings
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Agent orchestration framework</p>
            <h1>Orchestra</h1>
          </div>

          <div className="status-cluster">
            <div className="status-pill">
              <span className="status-pill__label">Environment</span>
              <strong>{appInfo?.environment ?? "loading"}</strong>
            </div>
            <div className="status-pill">
              <span className="status-pill__label">Backend</span>
              <strong>{appInfo?.backendStatus ?? "loading"}</strong>
            </div>
          </div>
        </header>

        {activePage === "settings" ? (
          <section className="panel-stack">
            <section className="panel panel--hero">
              <div className="settings-hero">
                <div>
                  <p className="eyebrow">Configuration and visibility</p>
                  <h2>Settings</h2>
                  <p>
                    Workflows live here first so they can be created, configured, and managed without turning the main app into a
                    diagram editor too early.
                  </p>
                </div>

                <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                  {SETTINGS_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      className={settingsTab === tab.id ? "nav-item nav-item--active" : "nav-item"}
                      type="button"
                      role="tab"
                      aria-selected={settingsTab === tab.id}
                      onClick={() => setSettingsTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {settingsTab === "logs" ? (
              <section className="panel">
                <div className="panel__header">
                  <div>
                    <p className="eyebrow">Application logs</p>
                    <h3>Runtime log</h3>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => void loadLogs()}>
                    Refresh
                  </button>
                </div>

                {loadingLogs ? <p className="muted-copy">Loading logs…</p> : null}

                <div className="log-list" role="log" aria-live="polite">
                  {logs.map((entry) => (
                    <article className="log-entry" key={entry.id}>
                      <div className="log-entry__meta">
                        <span className={`log-level log-level--${entry.level}`}>{entry.level}</span>
                        <span>{entry.target}</span>
                        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                      </div>
                      <p>{entry.message}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <section className="workflow-shell">
                <aside className="panel workflow-list-panel">
                  <div className="panel__header panel__header--stacked">
                    <div>
                      <p className="eyebrow">Workflow library</p>
                      <h3>Workflows</h3>
                    </div>
                    <div className="action-cluster">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={includeArchivedWorkflows}
                          onChange={(event) => setIncludeArchivedWorkflows(event.target.checked)}
                        />
                        Show archived
                      </label>
                      <button className="secondary-button" type="button" onClick={() => void loadWorkflows()}>
                        Refresh
                      </button>
                    </div>
                  </div>

                  <button className="primary-button" type="button" onClick={beginCreateWorkflow}>
                    New workflow
                  </button>

                  {loadingWorkflows ? <p className="muted-copy">Loading workflows…</p> : null}
                  {workflowActionError ? <p className="error-copy">{workflowActionError}</p> : null}

                  <div className="workflow-list" role="list">
                    {workflows.map((workflow) => (
                      <button
                        key={workflow.id}
                        className={workflow.id === selectedWorkflowId && !isCreatingWorkflow ? "workflow-list-item workflow-list-item--active" : "workflow-list-item"}
                        type="button"
                        onClick={() => {
                          setSelectedWorkflowId(workflow.id);
                          setIsCreatingWorkflow(false);
                        }}
                      >
                        <div className="workflow-list-item__header">
                          <strong>{workflow.name}</strong>
                          <span className={`status-badge status-badge--${workflow.archived ? "neutral" : "accent"}`}>
                            {workflow.archived ? "Archived" : "Active"}
                          </span>
                        </div>
                        <div className="workflow-list-item__meta">
                          <span>{workflow.slug}</span>
                          <span>{workflow.laneCount} lanes</span>
                        </div>
                        <div className="workflow-list-item__footer">
                          <span>{workflow.description || "No description"}</span>
                          <span>{formatDateTime(workflow.updatedAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </aside>

                <section className="panel workflow-editor-panel">
                  <div className="panel__header panel__header--session-detail">
                    <div>
                      <p className="eyebrow">Workflow editor</p>
                      <h3>{isCreatingWorkflow ? "New workflow" : selectedWorkflowSummary?.name ?? "Select a workflow"}</h3>
                      <div className="session-detail__meta">
                        {!isCreatingWorkflow && selectedWorkflowSummary ? (
                          <>
                            <span>{selectedWorkflowSummary.slug}</span>
                            <span>{selectedWorkflowSummary.laneCount} lanes</span>
                            <span>{loadedWorkflowArchived ? "Archived" : "Editable"}</span>
                          </>
                        ) : (
                          <span>Structured workflow editor</span>
                        )}
                      </div>
                    </div>

                    <div className="action-cluster">
                      <button className="secondary-button" type="button" disabled={savingWorkflow || !selectedWorkflowSummary} onClick={() => void handleDuplicateWorkflow()}>
                        Duplicate
                      </button>
                      <button className="secondary-button" type="button" disabled={savingWorkflow || !selectedWorkflowSummary || loadedWorkflowArchived} onClick={() => void handleArchiveWorkflow()}>
                        Archive
                      </button>
                      <button className="primary-button" type="button" disabled={savingWorkflow || loadingWorkflowDetail} onClick={() => void handleSaveWorkflow()}>
                        {savingWorkflow ? "Saving…" : loadedWorkflowId && !isCreatingWorkflow ? "Save changes" : "Create workflow"}
                      </button>
                    </div>
                  </div>

                  {loadingWorkflowDetail ? <p className="muted-copy">Loading workflow…</p> : null}

                  <div className="workflow-editor-grid">
                    <section className="workflow-section">
                      <div className="workflow-section__header">
                        <div>
                          <p className="eyebrow">Workflow metadata</p>
                          <h4>Basics</h4>
                        </div>
                      </div>

                      <div className="workflow-form-grid">
                        <label className="field-group">
                          <span className="field-group__label">Workflow name</span>
                          <input
                            className="text-input"
                            type="text"
                            value={workflowDraft.name}
                            onChange={(event) => updateWorkflowDraft((draft) => ({ ...draft, name: event.target.value }))}
                          />
                          {getWorkflowValidationForPath(workflowValidation, "name").map((error) => (
                            <span className="field-error" key={error.message}>{error.message}</span>
                          ))}
                        </label>

                        <label className="field-group workflow-form-grid__full">
                          <span className="field-group__label">Description</span>
                          <textarea
                            className="text-area"
                            rows={3}
                            value={workflowDraft.description ?? ""}
                            onChange={(event) => updateWorkflowDraft((draft) => ({ ...draft, description: event.target.value }))}
                          />
                        </label>
                      </div>
                    </section>

                    <section className="workflow-section">
                      <div className="workflow-section__header">
                        <div>
                          <p className="eyebrow">Ordered lanes</p>
                          <h4>Lane setup</h4>
                        </div>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: [...draft.lanes, createEmptyLane(draft.lanes.length)].map((lane, index) => ({ ...lane, order: index })),
                            }))
                          }
                        >
                          Add lane
                        </button>
                      </div>

                      {getWorkflowValidationForPath(workflowValidation, "lanes").map((error) => (
                        <p className="field-error" key={error.message}>{error.message}</p>
                      ))}

                      <div className="workflow-lane-list">
                        {workflowDraft.lanes.map((lane, index) => (
                          <article className="workflow-lane-card" key={lane.id ?? `lane-${index}`}>
                            <div className="workflow-lane-card__header">
                              <div>
                                <p className="eyebrow">Lane {index + 1}</p>
                                <h4>{lane.name.trim() || lane.key.trim() || "Untitled lane"}</h4>
                              </div>
                              <div className="action-cluster">
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={index === 0}
                                  onClick={() =>
                                    updateWorkflowDraft((draft) => {
                                      const lanes = [...draft.lanes];
                                      [lanes[index - 1], lanes[index]] = [lanes[index]!, lanes[index - 1]!];
                                      return { ...draft, lanes: lanes.map((entry, order) => ({ ...entry, order })) };
                                    })
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={index === workflowDraft.lanes.length - 1}
                                  onClick={() =>
                                    updateWorkflowDraft((draft) => {
                                      const lanes = [...draft.lanes];
                                      [lanes[index], lanes[index + 1]] = [lanes[index + 1]!, lanes[index]!];
                                      return { ...draft, lanes: lanes.map((entry, order) => ({ ...entry, order })) };
                                    })
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={workflowDraft.lanes.length <= 1}
                                  onClick={() =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.filter((_, laneIndex) => laneIndex !== index).map((entry, order) => ({ ...entry, order })),
                                    }))
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            </div>

                            <div className="workflow-form-grid">
                              <label className="field-group">
                                <span className="field-group__label">Lane name</span>
                                <input
                                  className="text-input"
                                  type="text"
                                  value={lane.name}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, name: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                />
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].name`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">Lane key</span>
                                <input
                                  className="text-input"
                                  type="text"
                                  value={lane.key}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, key: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                />
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].key`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">Owner type</span>
                                <select
                                  className="select-input"
                                  value={lane.assignedEntityType}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index
                                          ? {
                                              ...entry,
                                              assignedEntityType: event.target.value,
                                              assignedEntityId: event.target.value === "user" ? "" : entry.assignedEntityId,
                                            }
                                          : entry,
                                      ),
                                    }))
                                  }
                                >
                                  <option value="user">User</option>
                                  <option value="agent">Agent</option>
                                  <option value="role">Role</option>
                                </select>
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].assignedEntityType`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">Owner reference</span>
                                <input
                                  className="text-input"
                                  type="text"
                                  placeholder={lane.assignedEntityType === "user" ? "Not used for user lanes" : "e.g. reviewer-role"}
                                  value={lane.assignedEntityId ?? ""}
                                  disabled={lane.assignedEntityType === "user"}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, assignedEntityId: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                />
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].assignedEntityId`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group workflow-form-grid__full">
                                <span className="field-group__label">Entry prompt template</span>
                                <textarea
                                  className="text-area"
                                  rows={3}
                                  value={lane.entryPromptTemplate ?? ""}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, entryPromptTemplate: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                />
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">On success</span>
                                <select
                                  className="select-input"
                                  value={lane.successTargetLaneId ?? ""}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, successTargetLaneId: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                >
                                  <option value="">End workflow</option>
                                  {laneIdOptions
                                    .filter((option) => option.id !== lane.id)
                                    .map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.label}
                                      </option>
                                    ))}
                                </select>
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].successTargetLaneId`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">On failure</span>
                                <select
                                  className="select-input"
                                  value={lane.failureTargetLaneId ?? ""}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, failureTargetLaneId: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                >
                                  <option value="">End workflow</option>
                                  {laneIdOptions
                                    .filter((option) => option.id !== lane.id)
                                    .map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.label}
                                      </option>
                                    ))}
                                </select>
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].failureTargetLaneId`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>

                              <label className="field-group">
                                <span className="field-group__label">Needs user intervention</span>
                                <select
                                  className="select-input"
                                  value={lane.userInterventionTargetLaneId ?? ""}
                                  onChange={(event) =>
                                    updateWorkflowDraft((draft) => ({
                                      ...draft,
                                      lanes: draft.lanes.map((entry, laneIndex) =>
                                        laneIndex === index ? { ...entry, userInterventionTargetLaneId: event.target.value } : entry,
                                      ),
                                    }))
                                  }
                                >
                                  <option value="">End workflow</option>
                                  {laneIdOptions
                                    .filter((option) => option.id !== lane.id)
                                    .map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.label}
                                      </option>
                                    ))}
                                </select>
                                {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].userInterventionTargetLaneId`).map((error) => (
                                  <span className="field-error" key={error.message}>{error.message}</span>
                                ))}
                              </label>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>

                    <section className="workflow-section">
                      <div className="workflow-section__header">
                        <div>
                          <p className="eyebrow">Validation</p>
                          <h4>Save readiness</h4>
                        </div>
                      </div>

                      {validationSummary.length ? (
                        <ul className="workflow-validation-list">
                          {validationSummary.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-copy">No validation issues right now.</p>
                      )}
                    </section>
                  </div>
                </section>
              </section>
            )}
          </section>
        ) : activePage === "sessions" ? (
          <section className="panel-stack">
            <section className="panel panel--hero panel--session-hero">
              <div>
                <p className="eyebrow">First shipping vertical slice</p>
                <h2>Sessions</h2>
                <p>
                  Create, resume, subscribe to, and interact with sessions directly from the app. This is the first real product
                  surface for Orchestra.
                </p>
              </div>

              <div className="session-hero__stats">
                <div className="metric-card">
                  <span className="metric-card__label">Known sessions</span>
                  <strong>{sessions.length}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Active</span>
                  <strong>{activeSessionCount}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Subscribed</span>
                  <strong>{subscribedSessionCount}</strong>
                </div>
              </div>
            </section>

            <section className="session-shell">
              <aside className="panel session-list-panel">
                <div className="panel__header panel__header--stacked">
                  <div>
                    <p className="eyebrow">Session inventory</p>
                    <h3>Known sessions</h3>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => void loadSessions()}>
                    Refresh
                  </button>
                </div>

                <form
                  className="session-create-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSessionAction(async () => {
                      const session = await createSession(newSessionTitle);
                      setNewSessionTitle("");
                      return session;
                    });
                  }}
                >
                  <label className="field-group">
                    <span className="field-group__label">New session title</span>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="e.g. Session-first spike"
                      value={newSessionTitle}
                      onChange={(event) => setNewSessionTitle(event.target.value)}
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={isSubmitting}>
                    Create session
                  </button>
                </form>

                {loadingSessions ? <p className="muted-copy">Loading sessions…</p> : null}
                {sessionActionError ? <p className="error-copy">{sessionActionError}</p> : null}

                <div className="session-list" role="list">
                  {sessions.map((session) => {
                    const displayStatus = pendingRuns[session.id] ? "streaming" : session.status;
                    return (
                      <button
                        key={session.id}
                        className={session.id === selectedSession?.id ? "session-list-item session-list-item--active" : "session-list-item"}
                        type="button"
                        onClick={() => setSelectedSessionId(session.id)}
                      >
                        <div className="session-list-item__header">
                          <strong>{session.title}</strong>
                          <span className={`status-badge status-badge--${getStatusTone(displayStatus)}`}>{displayStatus}</span>
                        </div>
                        <div className="session-list-item__meta">
                          <span>{session.id}</span>
                          <span>{formatDateTime(session.updatedAt)}</span>
                        </div>
                        <div className="session-list-item__footer">
                          <span>{session.events.length} events</span>
                          <span>{session.subscribed ? "Subscribed" : "Unsubscribed"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section className="panel session-detail-panel">
                {selectedSession ? (
                  <>
                    <div className="panel__header panel__header--session-detail">
                      <div>
                        <p className="eyebrow">Session detail</p>
                        <h3>{selectedSession.title}</h3>
                        <div className="session-detail__meta">
                          <span>{selectedSession.id}</span>
                          <span>Created {formatDateTime(selectedSession.createdAt)}</span>
                          <span>Updated {formatDateTime(selectedSession.updatedAt)}</span>
                        </div>
                      </div>

                      <div className="action-cluster action-cluster--session-tools">
                        <label className="field-group field-group--compact session-model-field">
                          <span className="field-group__label">Model</span>
                          <select
                            className="select-input"
                            value={selectedModelState?.currentModel ? `${selectedModelState.currentModel.provider}/${selectedModelState.currentModel.id}` : ""}
                            disabled={
                              loadingModelSessionId === selectedSession.id ||
                              changingModelSessionId === selectedSession.id ||
                              Boolean(selectedSessionPendingRun)
                            }
                            onChange={(event) => void handleModelChange(event.target.value)}
                          >
                            {!selectedModelState?.availableModels.length || !selectedModelState.currentModel ? (
                              <option value="">{formatModelOptionLabel(selectedModelState)}</option>
                            ) : null}
                            {selectedModelState?.availableModels.map((model) => (
                              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                                {model.name} · {model.provider}
                              </option>
                            ))}
                          </select>
                        </label>

                        <span className={`status-badge status-badge--${getStatusTone(selectedSessionDisplayStatus)}`}>{selectedSessionDisplayStatus}</span>
                        <span className={selectedSession.subscribed ? "status-badge status-badge--accent" : "status-badge status-badge--neutral"}>
                          {selectedSession.subscribed ? "Subscribed" : "Not subscribed"}
                        </span>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={selectedSessionBusy}
                          onClick={() => void runSessionAction(() => resumeSession(selectedSession.id))}
                        >
                          Resume session
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={selectedSessionBusy}
                          onClick={() =>
                            void runSessionAction(() =>
                              selectedSession.subscribed ? unsubscribeSession(selectedSession.id) : subscribeSession(selectedSession.id),
                            )
                          }
                        >
                          {selectedSession.subscribed ? "Unsubscribe" : "Subscribe"}
                        </button>
                      </div>
                    </div>

                    <div className="session-transcript" ref={transcriptRef} role="log" aria-live="polite">
                      {displayedEvents.map((event) => (
                        <article
                          className={`transcript-event transcript-event--${getEventTone(event.kind)}${event.pending ? " transcript-event--pending" : ""}`}
                          key={event.id}
                        >
                          <div className="transcript-event__meta">
                            <span>{event.kind}</span>
                            <div className="transcript-event__meta-group">
                              {event.pending ? <span className="pending-badge">Pending</span> : null}
                              <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                            </div>
                          </div>
                          <p>{event.message || (event.kind === "assistant" ? "Thinking…" : "Queued…")}</p>
                        </article>
                      ))}
                    </div>

                    <form
                      className="composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleSendMessage();
                      }}
                    >
                      <label className="field-group field-group--composer">
                        <span className="field-group__label">Send message</span>
                        <textarea
                          className="text-area"
                          rows={4}
                          placeholder="Tell the session what to do next…"
                          value={draftMessage}
                          onChange={(event) => setDraftMessage(event.target.value)}
                          onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                              event.preventDefault();
                              handleSendMessage();
                            }
                          }}
                        />
                      </label>
                      <div className="composer__footer">
                        <p className="muted-copy">
                          {selectedSessionPendingRun ? "Response in progress…" : "Press Ctrl+Enter or ⌘+Enter to send."}
                        </p>
                        <button
                          className="primary-button"
                          type="submit"
                          disabled={Boolean(selectedSessionPendingRun) || draftMessage.trim().length === 0}
                        >
                          {selectedSessionPendingRun ? "Sending…" : "Send message"}
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <div className="empty-state">
                    <p className="eyebrow">No session selected</p>
                    <h3>Create or select a session</h3>
                    <p>Use the session list to select an existing session or create a new one to begin the interaction flow.</p>
                  </div>
                )}
              </section>
            </section>
          </section>
        ) : (
          <section className="panel-stack">
            <section className="panel panel--hero">
              <p className="eyebrow">{PAGE_COPY[activePage].eyebrow}</p>
              <h2>{PAGE_COPY[activePage].title}</h2>
              <p>{PAGE_COPY[activePage].body}</p>
            </section>

            <section className="panel panel--split">
              <div>
                <p className="eyebrow">Foundation</p>
                <h3>Session workspace</h3>
                <ul className="bullet-list">
                  <li>Project switcher placeholder and stable left navigation</li>
                  <li>Live transcript that stays pinned to the newest message</li>
                  <li>Keyboard-first composer with optimistic pending states</li>
                  <li>Per-session model selection from the app</li>
                </ul>
              </div>

              <div>
                <p className="eyebrow">Next orchestration layers</p>
                <h3>After sessions</h3>
                <ul className="bullet-list">
                  <li>Projects and repositories</li>
                  <li>Task workflow lanes and lane history</li>
                  <li>Agents, roles, queues, and interruption semantics</li>
                  <li>Multi-session orchestration and richer runtime controls</li>
                </ul>
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
