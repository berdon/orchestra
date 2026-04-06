import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cleanupStaleBridgeInstances,
  clearLogs,
  createSession,
  deleteSession,
  getAppInfo,
  getBridgeDiagnostics,
  getInitialAgentTerminalSessionId,
  getInitialAgentTerminalWindowFlag,
  getInitialLogsWindowFlag,
  getLogs,
  exportLogsBundle,
  getSessionModelState,
  getSessionRecord,
  getCurrentAgentTerminalSessionId,
  isCurrentAgentTerminalWindow,
  isCurrentLogsWindow,
  listSessions,
  listTasks,
  listWorkflows,
  listenToSessionChanges,
  listenToSessionStream,
  openLogsWindow,
  reportClientError,
  sendSessionMessage,
  setSessionModel,
  stopSessionRuntime,
  subscribeSession,
  unsubscribeSession,
} from "./lib/tauri";
import { ensureAgentSession, listAgentOperations, openAgentSessionInTerminal } from "./lib/agents";
import { buildCommandPaletteItems, type CommandPaletteItem } from "./lib/commandPalette";
import { getActiveProjectId, listProjects, setActiveProjectId } from "./lib/projects";
import { listRoleOperations } from "./lib/roleRuntime";
import { getSessionPromptSettings, updateSessionPromptSettings } from "./lib/projectSettings";
import { AgentsPage } from "./agents/AgentsPage";
import { CommandPalette } from "./components/CommandPalette";
import { RuntimeLogPanel } from "./components/RuntimeLogPanel";
import { SupervisorQuickChatModal } from "./components/SupervisorQuickChatModal";
import { InboxPage } from "./pages/InboxPage";
import { AgentChatPage } from "./pages/AgentChatPage";
import { AgentTerminalWindowPage } from "./pages/AgentTerminalWindowPage";
import { SessionsPage } from "./pages/SessionsPage";
import { TasksPage } from "./pages/TasksPage";
import type { TaskBoardViewMode } from "./pages/tasks/TasksOverviewPage";
import { AgentsPanel } from "./settings/AgentsPanel";
import { ChannelsPanel } from "./settings/ChannelsPanel";
import { ProjectsPanel } from "./settings/ProjectsPanel";
import { RolesPanel } from "./settings/RolesPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { WorkflowsPanel } from "./settings/WorkflowsPanel";
import type {
  AgentOperationsSnapshot,
  AppInfo,
  BridgeDiagnostics,
  JsonValue,
  LogEntry,
  ProjectSessionPromptSettings,
  PrimaryPage,
  ProjectSummary,
  SessionActivityState,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionScrollState,
  SessionStatus,
  SessionStreamEnvelope,
  SettingsTab,
} from "./types";

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "inbox", label: "Inbox" },
  { id: "agents", label: "Agents" },
  { id: "chat", label: "Chat" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

const SETTINGS_TABS = [
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "roles", label: "Roles" },
  { id: "workflows", label: "Workflows" },
  { id: "channels", label: "Channels" },
  { id: "general", label: "General" },
] as const;

const SUPERVISOR_AGENT_ID = "agent-supervisor";
const TASK_BOARD_VIEW_MODE_STORAGE_KEY = "orchestra.preferences.task-board-view-mode";

function loadStoredTaskBoardViewMode(): TaskBoardViewMode {
  const stored = window.localStorage.getItem(TASK_BOARD_VIEW_MODE_STORAGE_KEY);
  return stored === "table" || stored === "cards" ? stored : "cards";
}

function supervisorQuickChatStorageKey(projectId: string | null) {
  return `orchestra.quick-chat.supervisor.${projectId ?? "default"}`;
}

interface PendingSessionRun {
  runId: string;
  userEvent: SessionEvent;
  assistantEvent?: SessionEvent;
}

function buildPendingAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: `pending-assistant-${runId}`,
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    runId,
    ...overrides,
  };
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
    case "closed":
      return "neutral";
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

function isScrolledToBottom(node: HTMLDivElement, threshold = 24) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function isObject(value: JsonValue | undefined | null): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: JsonValue | undefined | null) {
  return Array.isArray(value) ? value : [];
}

function asString(value: JsonValue | undefined | null) {
  return typeof value === "string" ? value : "";
}

function extractRpcMessageText(message: JsonValue | undefined | null) {
  if (!isObject(message)) {
    return "";
  }

  return asArray(message.content)
    .map((block) => {
      if (!isObject(block)) {
        return "";
      }

      if (asString(block.type) === "text") {
        return asString(block.text);
      }

      if (asString(block.type) === "thinking") {
        return asString(block.thinking);
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function getRpcEventType(envelope: SessionStreamEnvelope) {
  return isObject(envelope.event) ? asString(envelope.event.type) : "";
}

function getRpcAssistantDeltaType(envelope: SessionStreamEnvelope) {
  if (!isObject(envelope.event)) {
    return "";
  }

  const delta = envelope.event.assistantMessageEvent;
  return isObject(delta) ? asString(delta.type) : "";
}

function buildTranscriptEvent(kind: SessionEvent["kind"], message: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createClientId(`event-${kind}`),
    kind,
    message,
    timestamp,
    ...overrides,
  };
}

function buildToolPlaceholder(runId: string, timestamp: string) {
  return buildPendingAssistantEvent(runId, timestamp, {
    message: "Running tools…",
    thinking: false,
  });
}

function buildStreamAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createClientId(`stream-assistant-${runId}`),
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    runId,
    ...overrides,
  };
}

function hasVisibleAssistantText(event?: SessionEvent) {
  return Boolean(event?.message.trim() && event.message.trim() !== "Running tools…");
}

function formatJsonSummary(value: JsonValue | undefined | null) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (isObject(value) && Array.isArray(value.content)) {
    const extracted = value.content
      .map((block) => {
        if (!isObject(block)) {
          return "";
        }
        return asString(block.text) || asString(block.thinking);
      })
      .filter(Boolean)
      .join("\n\n");

    if (extracted) {
      return extracted;
    }
  }

  return JSON.stringify(value, null, 2);
}

function inferCodeFenceLanguage(value: JsonValue | undefined | null, formatted?: string) {
  if (value === undefined || value === null) {
    return "text";
  }

  const trimmed = (formatted ?? (typeof value === "string" ? value : "")).trim();
  if (!trimmed) {
    return typeof value === "string" ? "text" : "json";
  }

  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // continue
  }

  if (/^<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return "html";
  }

  if (/^#{1,6}\s|```|^[-*+]\s|^\d+\.\s/m.test(trimmed)) {
    return "markdown";
  }

  if (/(^|\n)(\$ |npm |pnpm |yarn |cargo |git |bash |sh )/.test(trimmed)) {
    return "bash";
  }

  if (typeof value !== "string" && !formatted) {
    return "json";
  }

  return "text";
}

function buildCodeFence(value: JsonValue | undefined | null) {
  const formatted = formatJsonSummary(value);
  if (!formatted) {
    return "";
  }

  return `\`\`\`${inferCodeFenceLanguage(value, formatted)}\n${formatted}\n\`\`\``;
}

function summarizeToolArgument(value: JsonValue | undefined | null) {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const normalized = JSON.stringify(value);
    return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
  }
  const normalized = JSON.stringify(value);
  return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
}

function formatToolCallLabel(toolName: string, args: JsonValue | undefined | null) {
  const argValues = Array.isArray(args)
    ? args
    : isObject(args)
      ? Object.values(args)
      : args === undefined || args === null
        ? []
        : [args];
  return `${toolName}(${argValues.map((value) => summarizeToolArgument(value)).join(", ")})`;
}

function buildToolEventMessage(args: JsonValue | undefined | null, result?: JsonValue | undefined | null, durationMs?: number | null) {
  const sections: string[] = [];
  const formattedArgs = buildCodeFence(args);
  const formattedResult = buildCodeFence(result);

  if (formattedArgs) {
    sections.push(["#### Input", formattedArgs].join("\n\n"));
  }

  if (formattedResult) {
    sections.push(["#### Output", formattedResult].join("\n\n"));
  }

  if (durationMs && Number.isFinite(durationMs)) {
    sections.push(["#### Duration", `\`\`\`text\n${durationMs}ms\n\`\`\``].join("\n\n"));
  }

  return sections.join("\n\n");
}

function deriveSessionActivityState(session: SessionRecord): SessionActivityState {
  const latestEvent = session.events[session.events.length - 1];
  if (session.status === "failed") {
    return "error";
  }
  if (latestEvent?.pending && latestEvent?.message.includes("Running tools")) {
    return "tool_running";
  }
  if (latestEvent?.thinking) {
    return "thinking";
  }
  if (session.status === "streaming") {
    return "streaming";
  }
  return "idle";
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    terminalAttached: session.terminalAttached ?? false,
    activityState: session.activityState ?? deriveSessionActivityState(session),
    lastActivityAt: session.lastActivityAt ?? session.updatedAt,
  };
}

function areSessionEventsEqual(left: SessionEvent[], right: SessionEvent[]) {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return Boolean(other)
      && event.id === other.id
      && event.kind === other.kind
      && event.message === other.message
      && event.timestamp === other.timestamp
      && event.pending === other.pending
      && event.thinking === other.thinking
      && event.runId === other.runId
      && event.label === other.label
      && event.presentation === other.presentation;
  });
}

function areSessionDebugInfoEqual(left?: SessionRecord["debugInfo"], right?: SessionRecord["debugInfo"]) {
  if (!left && !right) {
    return true;
  }

  return left?.projectRoot === right?.projectRoot
    && left?.managedRepositoryPath === right?.managedRepositoryPath
    && left?.worktreePath === right?.worktreePath
    && left?.sessionCwd === right?.sessionCwd;
}

function areSessionRecordsEqual(left: SessionRecord, right: SessionRecord) {
  return left.id === right.id
    && left.title === right.title
    && left.status === right.status
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.subscribed === right.subscribed
    && left.activityState === right.activityState
    && left.activeToolName === right.activeToolName
    && left.lastActivityAt === right.lastActivityAt
    && areSessionDebugInfoEqual(left.debugInfo, right.debugInfo)
    && areSessionEventsEqual(left.events, right.events);
}

function areSessionListsEqual(left: SessionRecord[], right: SessionRecord[]) {
  return left.length === right.length && left.every((session, index) => {
    const other = right[index];
    return Boolean(other) && areSessionRecordsEqual(session, other);
  });
}

function sortSessionRecords(sessions: SessionRecord[]) {
  return [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function App() {
  const [activePage, setActivePage] = useState<PrimaryPage>("sessions");
  const [sessionFilter, setSessionFilter] = useState<"active" | "closed">("active");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("projects");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(getActiveProjectId());
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bridgeDiagnostics, setBridgeDiagnostics] = useState<BridgeDiagnostics | null>(null);
  const [sessionPromptSettings, setSessionPromptSettings] = useState<ProjectSessionPromptSettings | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [logExportMessage, setLogExportMessage] = useState<string | null>(null);
  const [logExportError, setLogExportError] = useState<string | null>(null);
  const [includeRelatedSessionSnapshot, setIncludeRelatedSessionSnapshot] = useState(false);
  const [loadingBridgeDiagnostics, setLoadingBridgeDiagnostics] = useState(false);
  const [refreshingBridgeDiagnostics, setRefreshingBridgeDiagnostics] = useState(false);
  const [isLogsWindow, setIsLogsWindow] = useState(() => getInitialLogsWindowFlag());
  const [isAgentTerminalWindow, setIsAgentTerminalWindow] = useState(() => getInitialAgentTerminalWindowFlag());
  const [agentTerminalSessionId, setAgentTerminalSessionId] = useState<string | null>(() => getInitialAgentTerminalSessionId());
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatAgents, setChatAgents] = useState<AgentOperationsSnapshot[]>([]);
  const [selectedChatAgentId, setSelectedChatAgentId] = useState<string | null>(null);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [loadingChatAgents, setLoadingChatAgents] = useState(false);
  const [loadingChatSessionAgentId, setLoadingChatSessionAgentId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [draftMessages, setDraftMessages] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingSessionRun>>({});
  const [modelStates, setModelStates] = useState<Record<string, SessionModelState>>({});
  const [loadingModelSessionId, setLoadingModelSessionId] = useState<string | null>(null);
  const [changingModelSessionId, setChangingModelSessionId] = useState<string | null>(null);
  const [sessionScrollState, setSessionScrollState] = useState<SessionScrollState>({ lockedToBottom: true });
  const [tasksCreateToken, setTasksCreateToken] = useState(0);
  const [tasksCreateProjectId, setTasksCreateProjectId] = useState<string | null>(null);
  const [taskBoardViewMode, setTaskBoardViewMode] = useState<TaskBoardViewMode>(() => loadStoredTaskBoardViewMode());
  const [tasksOverviewToken, setTasksOverviewToken] = useState(0);
  const [tasksOpenRequest, setTasksOpenRequest] = useState<{ taskId: string; token: number; projectId: string | null } | null>(null);
  const [agentsSelectionRequest, setAgentsSelectionRequest] = useState<{ type: "role" | "agent"; id: string; token: number } | null>(null);
  const [rolesSelectionRequest, setRolesSelectionRequest] = useState<{ roleId: string; token: number } | null>(null);
  const [workflowsSelectionRequest, setWorkflowsSelectionRequest] = useState<{ workflowId: string; token: number } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteLoading, setCommandPaletteLoading] = useState(false);
  const [commandPaletteItems, setCommandPaletteItems] = useState<CommandPaletteItem[]>([]);
  const [supervisorQuickChatOpen, setSupervisorQuickChatOpen] = useState(false);
  const [supervisorSessionId, setSupervisorSessionId] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const viewedSessionIdRef = useRef<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );

  const filteredSessions = useMemo(
    () => sessions.filter((session) => (sessionFilter === "closed" ? session.status === "closed" : session.status !== "closed")),
    [sessionFilter, sessions],
  );

  const selectedSession = useMemo(
    () => filteredSessions.find((session) => session.id === selectedSessionId) ?? filteredSessions[0] ?? null,
    [filteredSessions, selectedSessionId],
  );

  const selectedChatAgent = useMemo(
    () => chatAgents.find((agent) => agent.agent.id === selectedChatAgentId)?.agent ?? null,
    [chatAgents, selectedChatAgentId],
  );

  const chatSession = useMemo(
    () => sessions.find((session) => session.id === chatSessionId) ?? null,
    [chatSessionId, sessions],
  );

  const viewedSession = activePage === "chat" ? chatSession : selectedSession;
  const viewedSessionPendingRun = viewedSession ? pendingRuns[viewedSession.id] : undefined;
  const viewedModelState = viewedSession ? modelStates[viewedSession.id] : undefined;
  const displayedEvents = viewedSession?.events ?? [];
  const viewedSessionDraftMessage = viewedSession ? draftMessages[viewedSession.id] ?? "" : "";
  const supervisorSession = useMemo(
    () => sessions.find((session) => session.id === supervisorSessionId) ?? null,
    [sessions, supervisorSessionId],
  );
  const supervisorSessionDraftMessage = supervisorSession ? draftMessages[supervisorSession.id] ?? "" : "";
  const supervisorPendingRun = supervisorSession ? pendingRuns[supervisorSession.id] : undefined;
  const isDetachedWindow = isLogsWindow || isAgentTerminalWindow;

  useEffect(() => {
    window.localStorage.setItem(TASK_BOARD_VIEW_MODE_STORAGE_KEY, taskBoardViewMode);
  }, [taskBoardViewMode]);

  useEffect(() => {
    if (activePage === "tasks") {
      setTaskBoardViewMode(loadStoredTaskBoardViewMode());
    }
  }, [activePage]);

  function handleTaskBoardViewModeChange(viewMode: TaskBoardViewMode) {
    window.localStorage.setItem(TASK_BOARD_VIEW_MODE_STORAGE_KEY, viewMode);
    setTaskBoardViewMode(viewMode);
  }

  const mergeSessionRecord = useCallback((updatedSession: SessionRecord, options?: { select?: boolean }) => {
    const normalizedSession = normalizeSessionRecord(updatedSession);
    setSessions((current) => {
      const nextSessions = sortSessionRecords([
        normalizedSession,
        ...current.filter((session) => session.id !== normalizedSession.id),
      ]);
      return areSessionListsEqual(current, nextSessions) ? current : nextSessions;
    });

    if (options?.select !== false) {
      setSelectedSessionId((current) => (current === normalizedSession.id ? current : normalizedSession.id));
    }
  }, []);

  const applySessionUpdate = useCallback((updatedSession: SessionRecord) => {
    mergeSessionRecord(updatedSession);
  }, [mergeSessionRecord]);

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

  const patchSessionRecord = useCallback((sessionId: string, patch: (session: SessionRecord) => SessionRecord) => {
    setSessions((current) => {
      const currentSession = current.find((session) => session.id === sessionId);
      if (!currentSession) {
        return current;
      }

      const patchedSession = normalizeSessionRecord(patch(currentSession));
      if (areSessionRecordsEqual(currentSession, patchedSession)) {
        return current;
      }

      const nextSessions = sortSessionRecords(
        current.map((session) => (session.id === sessionId ? patchedSession : session)),
      );
      return areSessionListsEqual(current, nextSessions) ? current : nextSessions;
    });
  }, []);

  const updateDraftMessage = useCallback((sessionId: string, value: string) => {
    setDraftMessages((current) => ({
      ...current,
      [sessionId]: value,
    }));
  }, []);

  const patchStreamingAssistantEvent = useCallback(
    (sessionId: string, runId: string, timestamp: string, patch: (event: SessionEvent) => SessionEvent) => {
      patchSessionRecord(sessionId, (session) => {
        const existingIndex = session.events.findIndex((event) => event.runId === runId && event.kind === "assistant");
        const baseEvent = existingIndex >= 0 ? session.events[existingIndex]! : buildStreamAssistantEvent(runId, timestamp);
        const nextEvent = patch(baseEvent);
        const nextEvents = existingIndex >= 0
          ? session.events.map((event, index) => (index === existingIndex ? nextEvent : event))
          : [...session.events, nextEvent];
        return {
          ...session,
          status: "streaming",
          updatedAt: timestamp,
          events: nextEvents,
        };
      });
    },
    [patchSessionRecord],
  );

  const upsertSystemEvent = useCallback(
    (
      sessionId: string,
      eventId: string,
      runId: string,
      timestamp: string,
      message: string,
      pending = false,
      options?: Pick<SessionEvent, "label" | "presentation">,
    ) => {
      patchSessionRecord(sessionId, (session) => {
        const existingIndex = session.events.findIndex((event) => event.id === eventId);
        const nextEvent: SessionEvent = {
          id: eventId,
          kind: "system",
          message,
          timestamp,
          pending,
          runId,
          label: options?.label,
          presentation: options?.presentation,
        };
        const nextEvents = existingIndex >= 0
          ? session.events.map((event, index) => (index === existingIndex ? nextEvent : event))
          : [...session.events, nextEvent];
        return {
          ...session,
          status: "streaming",
          updatedAt: timestamp,
          events: nextEvents,
        };
      });
    },
    [patchSessionRecord],
  );

  const updatePendingRun = useCallback((sessionId: string, updater: (run: PendingSessionRun) => PendingSessionRun) => {
    let nextRun: PendingSessionRun | undefined;

    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing) {
        return current;
      }

      const updatedRun = updater(existing);
      nextRun = updatedRun;
      return {
        ...current,
        [sessionId]: updatedRun,
      };
    });

    if (!nextRun) {
      return;
    }

    const resolvedRun = nextRun;
    patchSessionRecord(sessionId, (session) => {
      const persistedEvents = session.events.filter((event) => event.runId !== resolvedRun.runId);
      return {
        ...session,
        status: "streaming",
        updatedAt: resolvedRun.userEvent.timestamp,
        events: [
          ...persistedEvents,
          resolvedRun.userEvent,
          ...(resolvedRun.assistantEvent ? [resolvedRun.assistantEvent] : []),
        ],
      };
    });
  }, [patchSessionRecord]);

  async function loadLogs() {
    setLoadingLogs(true);
    try {
      setLogs(await getLogs());
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleClearLogs() {
    setClearingLogs(true);
    try {
      await clearLogs();
      setLogs([]);
    } finally {
      setClearingLogs(false);
    }
  }

  async function handleOpenLogsWindow() {
    await openLogsWindow();
  }

  async function handleExportLogsBundle() {
    setExportingLogs(true);
    setLogExportMessage(null);
    setLogExportError(null);
    try {
      const bundlePath = await exportLogsBundle(includeRelatedSessionSnapshot);
      setLogExportMessage(
        includeRelatedSessionSnapshot
          ? `Saved log bundle with related sessions and database snapshot to ${bundlePath}`
          : `Saved log bundle to ${bundlePath}`,
      );
      setLogs(await getLogs());
    } catch (error) {
      setLogExportError(error instanceof Error ? error.message : "Unable to export log bundle.");
    } finally {
      setExportingLogs(false);
    }
  }

  async function loadBridgeDiagnostics(options?: { background?: boolean }) {
    if (options?.background) {
      setRefreshingBridgeDiagnostics(true);
    } else {
      setLoadingBridgeDiagnostics(true);
    }
    try {
      setBridgeDiagnostics(await getBridgeDiagnostics());
    } finally {
      if (options?.background) {
        setRefreshingBridgeDiagnostics(false);
      } else {
        setLoadingBridgeDiagnostics(false);
      }
    }
  }

  async function handleCleanupStaleBridges() {
    setRefreshingBridgeDiagnostics(true);
    try {
      await cleanupStaleBridgeInstances();
      setLogs(await getLogs());
      setBridgeDiagnostics(await getBridgeDiagnostics());
    } finally {
      setRefreshingBridgeDiagnostics(false);
    }
  }

  async function loadAppInfo() {
    try {
      setAppInfo(await getAppInfo());
    } catch (error) {
      setSessionActionError(await reportClientError("ui.app.info", error, "Unable to load app info."));
    }
  }

  async function loadSessionPromptSettings() {
    if (!activeProject) {
      setSessionPromptSettings(null);
      return;
    }
    setSessionPromptSettings(await getSessionPromptSettings(activeProject.slug));
  }

  async function handleSaveSessionPromptTemplate(template: string | null) {
    if (!activeProject) {
      return;
    }
    setSessionPromptSettings(await updateSessionPromptSettings(template, activeProject.slug));
  }

  async function loadSessions(options?: { background?: boolean }) {
    if (!options?.background) {
      setLoadingSessions(true);
    }
    setSessionActionError(null);

    try {
      const nextSessions = sortSessionRecords((await listSessions()).map(normalizeSessionRecord));
      setSessions((current) => (areSessionListsEqual(current, nextSessions) ? current : nextSessions));
      setSelectedSessionId((current) => {
        const nextSelectedSessionId = current && nextSessions.some((session) => session.id === current)
          ? current
          : nextSessions[0]?.id ?? null;
        return current === nextSelectedSessionId ? current : nextSelectedSessionId;
      });
      setChatSessionId((current) => (current && nextSessions.some((session) => session.id === current) ? current : null));
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to load sessions.");
    } finally {
      if (!options?.background) {
        setLoadingSessions(false);
      }
    }
  }

  async function loadChatAgents(options?: { background?: boolean }) {
    if (!options?.background) {
      setLoadingChatAgents(true);
    }

    try {
      const nextAgents = await listAgentOperations(false, activeProjectId);
      setChatAgents(nextAgents);
      setSelectedChatAgentId((current) => {
        if (current && nextAgents.some((agent) => agent.agent.id === current)) {
          return current;
        }
        return nextAgents[0]?.agent.id ?? null;
      });
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to load chat agents.");
    } finally {
      if (!options?.background) {
        setLoadingChatAgents(false);
      }
    }
  }

  async function runSessionAction(action: () => Promise<SessionRecord>) {
    setIsSubmitting(true);
    setSessionActionError(null);

    try {
      const updatedSession = await action();
      applySessionUpdate(updatedSession);
    } catch (error) {
      setSessionActionError(await reportClientError("ui.sessions.action", error, "Session action failed."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setSessionActionError(null);
    setIsSubmitting(true);

    try {
      await deleteSession(sessionId);
      setPendingRuns((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setModelStates((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      await loadSessions();
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to dismiss session.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteClosedSessions() {
    setSessionActionError(null);
    setIsSubmitting(true);
    try {
      const closedSessions = sessions.filter((session) => session.status === "closed");
      for (const session of closedSessions) {
        await deleteSession(session.id);
      }
      setPendingRuns((current) => {
        const next = { ...current };
        for (const session of closedSessions) {
          delete next[session.id];
        }
        return next;
      });
      setModelStates((current) => {
        const next = { ...current };
        for (const session of closedSessions) {
          delete next[session.id];
        }
        return next;
      });
      await loadSessions();
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to dismiss closed sessions.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleSessionStreamEvent = useCallback(
    (payload: SessionStreamEnvelope) => {
      const eventType = getRpcEventType(payload);
      const eventTimestamp = payload.receivedAt ?? nowIso();
      const runId = payload.runId ?? createClientId("run");

      if (eventType === "agent_start") {
        patchSessionRecord(payload.sessionId, (session) => ({
          ...session,
          status: "streaming",
          updatedAt: eventTimestamp,
        }));
        return;
      }

      if (eventType === "message_start") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const message = rpcEvent?.message;
        const role = isObject(message) ? asString(message.role) : "";

        if (role === "user") {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
              timestamp: eventTimestamp,
            },
          }));
          return;
        }

        if (role === "assistant") {
          if (pendingRuns[payload.sessionId]) {
            updatePendingRun(payload.sessionId, (current) => ({
              ...current,
              userEvent: {
                ...current.userEvent,
                pending: false,
              },
              assistantEvent: current.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp),
            }));
          } else {
            patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
              ...event,
              pending: true,
              thinking: false,
              timestamp: eventTimestamp,
            }));
          }
        }
        return;
      }

      if (eventType === "message_update") {
        const deltaType = getRpcAssistantDeltaType(payload);
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const message = rpcEvent?.message;
        const delta = isObject(rpcEvent?.assistantMessageEvent) ? rpcEvent?.assistantMessageEvent : null;

        switch (deltaType) {
          case "thinking_start":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      pending: true,
                      thinking: true,
                      timestamp: eventTimestamp,
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp, { thinking: true }),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                pending: true,
                thinking: true,
                timestamp: eventTimestamp,
              }));
            }
            return;
          case "thinking_end":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      thinking: false,
                      pending: true,
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                thinking: false,
                pending: true,
              }));
            }
            return;
          case "text_start":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      pending: true,
                      thinking: false,
                      message: hasVisibleAssistantText(current.assistantEvent) ? current.assistantEvent.message : "",
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                pending: true,
                thinking: false,
                message: hasVisibleAssistantText(event) ? event.message : "",
              }));
            }
            return;
          case "text_delta":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => {
                const base = current.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp);
                const chunk = delta ? asString(delta.delta) : "";
                const nextMessage = hasVisibleAssistantText(base) ? `${base.message}${chunk}` : chunk;
                return {
                  ...current,
                  userEvent: {
                    ...current.userEvent,
                    pending: false,
                  },
                  assistantEvent: {
                    ...base,
                    message: nextMessage,
                    pending: true,
                    thinking: false,
                  },
                };
              });
            } else {
              const chunk = delta ? asString(delta.delta) : "";
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                message: hasVisibleAssistantText(event) ? `${event.message}${chunk}` : chunk,
                pending: true,
                thinking: false,
              }));
            }
            return;
          case "toolcall_start":
          case "toolcall_delta":
          case "toolcall_end":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent ?? buildToolPlaceholder(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                message: event.message || "Running tools…",
                pending: true,
                thinking: false,
              }));
            }
            return;
          case "error":
            patchSessionRecord(payload.sessionId, (session) => ({
              ...session,
              status: "failed",
              updatedAt: eventTimestamp,
              events: session.events.filter((event) => event.runId !== runId),
            }));
            removePendingRun(payload.sessionId, runId);
            setSessionActionError(asString(delta?.message) || extractRpcMessageText(message) || "Session action failed.");
            return;
          default:
            return;
        }
      }

      if (eventType === "tool_execution_start" || eventType === "tool_execution_update" || eventType === "tool_execution_end") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const toolName = asString(rpcEvent?.toolName) || "tool";
        const toolCallId = asString(rpcEvent?.toolCallId) || `${runId}-${toolName}`;
        const args = rpcEvent?.args;
        const toolEventId = `tool-execution-${toolCallId}`;

        if (pendingRuns[payload.sessionId]) {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
            },
            assistantEvent: current.assistantEvent ?? buildToolPlaceholder(runId, eventTimestamp),
          }));
        } else {
          patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
            ...event,
            message: event.message || "Running tools…",
            pending: true,
            thinking: false,
          }));
        }

        const toolCallLabel = formatToolCallLabel(toolName, args);

        if (eventType === "tool_execution_start") {
          patchSessionRecord(payload.sessionId, (session) => ({
            ...session,
            activityState: "tool_running",
            activeToolName: toolName,
            lastActivityAt: eventTimestamp,
          }));
          upsertSystemEvent(
            payload.sessionId,
            toolEventId,
            runId,
            eventTimestamp,
            buildToolEventMessage(args),
            true,
            { label: toolCallLabel, presentation: "tool_call" },
          );
        } else if (eventType === "tool_execution_update") {
          const partialResult = isObject(rpcEvent?.partialResult) ? rpcEvent?.partialResult : null;
          const partialContent = partialResult?.content;
          patchSessionRecord(payload.sessionId, (session) => ({
            ...session,
            activityState: "tool_running",
            activeToolName: toolName,
            lastActivityAt: eventTimestamp,
          }));
          upsertSystemEvent(
            payload.sessionId,
            toolEventId,
            runId,
            eventTimestamp,
            buildToolEventMessage(args, partialContent ?? partialResult),
            true,
            { label: toolCallLabel, presentation: "tool_call" },
          );
        } else {
          const result = rpcEvent?.result;
          const isError = rpcEvent?.isError === true;
          const durationMs = Number(rpcEvent?.durationMs ?? 0) || undefined;
          patchSessionRecord(payload.sessionId, (session) => ({
            ...session,
            activityState: isError ? "error" : "idle",
            activeToolName: null,
            lastActivityAt: eventTimestamp,
          }));
          upsertSystemEvent(
            payload.sessionId,
            toolEventId,
            runId,
            eventTimestamp,
            buildToolEventMessage(args, result, durationMs),
            false,
            { label: toolCallLabel, presentation: "tool_call" },
          );
        }
        return;
      }

      if (eventType === "turn_end") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const finalMessage = extractRpcMessageText(rpcEvent?.message);
        if (!finalMessage.trim()) {
          return;
        }

        if (pendingRuns[payload.sessionId]) {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
            },
            assistantEvent: current.assistantEvent
              ? {
                  ...current.assistantEvent,
                  message: finalMessage,
                  pending: false,
                  thinking: false,
                  timestamp: eventTimestamp,
                }
              : buildPendingAssistantEvent(runId, eventTimestamp, {
                  message: finalMessage,
                  pending: false,
                  thinking: false,
                }),
          }));
        } else {
          patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
            ...event,
            message: finalMessage,
            pending: false,
            thinking: false,
            timestamp: eventTimestamp,
          }));
        }
        return;
      }

      if (eventType === "agent_end") {
        void getSessionRecord(payload.sessionId)
          .then((record) => {
            applySessionUpdate(record);
            removePendingRun(payload.sessionId, runId);
          })
          .catch((error) => {
            removePendingRun(payload.sessionId, runId);
            setSessionActionError(error instanceof Error ? error.message : "Unable to refresh session.");
          });
        return;
      }

      if (eventType === "error") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        patchSessionRecord(payload.sessionId, (session) => ({
          ...session,
          status: "failed",
          activityState: "error",
          activeToolName: null,
          lastActivityAt: eventTimestamp,
          updatedAt: eventTimestamp,
          events: session.events.filter((event) => event.runId !== runId),
        }));
        removePendingRun(payload.sessionId, runId);
        setSessionActionError(asString(rpcEvent?.message) || "Session action failed.");
      }
    },
    [applySessionUpdate, patchSessionRecord, patchStreamingAssistantEvent, pendingRuns, removePendingRun, updatePendingRun, upsertSystemEvent],
  );

  useEffect(() => {
    const loadProjectCatalog = () => {
      void listProjects().then((nextProjects) => {
        setProjects(nextProjects);
        setActiveProjectIdState((current) => {
          if (current && nextProjects.some((project) => project.id === current)) {
            return current;
          }
          const fallback = nextProjects[0]?.id ?? null;
          if (fallback) {
            setActiveProjectId(fallback);
          }
          return fallback;
        });
      });
    };

    void loadAppInfo();
    void isCurrentLogsWindow().then(setIsLogsWindow);
    void isCurrentAgentTerminalWindow().then(setIsAgentTerminalWindow);
    void getCurrentAgentTerminalSessionId().then(setAgentTerminalSessionId);
    loadProjectCatalog();
    const onProjectsChanged = () => loadProjectCatalog();
    window.addEventListener("orchestra:projects-changed", onProjectsChanged);
    return () => window.removeEventListener("orchestra:projects-changed", onProjectsChanged);
  }, []);

  useEffect(() => {
    if (activeProjectId) {
      setActiveProjectId(activeProjectId);
    }
    setChatSessionId(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    void loadAppInfo();
    const intervalId = window.setInterval(() => {
      void loadAppInfo();
    }, 10000);
    const refreshOnFocus = () => {
      void loadAppInfo();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [isDetachedWindow]);

  useEffect(() => {
    const stored = window.localStorage.getItem(supervisorQuickChatStorageKey(activeProjectId));
    if (!stored) {
      setSupervisorSessionId(null);
      return;
    }

    try {
      const parsed = JSON.parse(stored) as { sessionId?: string; draft?: string };
      const restoredSessionId = parsed.sessionId ?? null;
      setSupervisorSessionId(restoredSessionId);
      if (restoredSessionId && parsed.draft) {
        const restoredDraft = parsed.draft;
        setDraftMessages((current) => ({
          ...current,
          [restoredSessionId]: restoredDraft,
        }));
      }
    } catch {
      setSupervisorSessionId(null);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    const draft = supervisorSessionId ? draftMessages[supervisorSessionId] ?? "" : "";
    window.localStorage.setItem(
      supervisorQuickChatStorageKey(activeProjectId),
      JSON.stringify({ sessionId: supervisorSessionId, draft }),
    );
  }, [activeProjectId, draftMessages, supervisorSessionId]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    let unlistenStream: (() => void) | undefined;
    let unlistenChanges: (() => void) | undefined;
    let cancelled = false;

    void listenToSessionStream((payload) => {
      handleSessionStreamEvent(payload);
      setSessions((current) => {
        if (current.some((session) => session.id === payload.sessionId)) {
          return current;
        }
        void loadSessions({ background: true });
        return current;
      });
    }).then((dispose) => {
      if (cancelled) {
        void dispose();
        return;
      }
      unlistenStream = dispose;
    });

    void listenToSessionChanges(() => {
      void loadSessions({ background: true });
    }).then((dispose) => {
      if (cancelled) {
        void dispose();
        return;
      }
      unlistenChanges = dispose;
    });

    return () => {
      cancelled = true;
      unlistenStream?.();
      unlistenChanges?.();
    };
  }, [handleSessionStreamEvent, isDetachedWindow]);

  useEffect(() => {
    if (isLogsWindow) {
      void loadLogs();
      const intervalId = window.setInterval(() => {
        void loadLogs();
      }, 1000);
      return () => {
        window.clearInterval(intervalId);
      };
    }

    if (!isAgentTerminalWindow) {
      void loadSessions();
    }
  }, [activeProjectId, isLogsWindow, isAgentTerminalWindow]);

  useEffect(() => {
    if (isDetachedWindow || (activePage !== "sessions" && activePage !== "chat")) {
      return;
    }

    void loadSessions({ background: true });

    const intervalId = window.setInterval(() => {
      void loadSessions({ background: true });
    }, 15000);

    const refreshOnFocus = () => {
      void loadSessions({ background: true });
    };

    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [activePage, isDetachedWindow]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "chat") {
      return;
    }

    void loadChatAgents();
  }, [activePage, activeProjectId, isDetachedWindow]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "chat" || !selectedChatAgentId) {
      return;
    }

    let cancelled = false;
    setLoadingChatSessionAgentId(selectedChatAgentId);
    setSessionActionError(null);

    void ensureAgentSession(selectedChatAgentId, activeProject?.id ?? null)
      .then((session) => {
        if (cancelled) {
          return;
        }
        mergeSessionRecord(session, { select: false });
        setChatSessionId(session.id);
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionActionError(error instanceof Error ? error.message : "Unable to open agent chat session.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingChatSessionAgentId((current) => (current === selectedChatAgentId ? null : current));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePage, activeProject?.id, isDetachedWindow, mergeSessionRecord, selectedChatAgentId]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "settings" || settingsTab !== "general") {
      return;
    }

    void loadLogs();
    void loadBridgeDiagnostics();
    void loadSessionPromptSettings();

    const intervalId = window.setInterval(() => {
      void loadLogs();
      void loadBridgeDiagnostics({ background: true });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [activePage, settingsTab, isDetachedWindow, activeProject?.slug]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    const previousViewedSessionId = viewedSessionIdRef.current;
    const nextViewedSessionId = (activePage === "sessions" || activePage === "chat") ? viewedSession?.id ?? null : null;

    viewedSessionIdRef.current = nextViewedSessionId;

    if (previousViewedSessionId && previousViewedSessionId !== nextViewedSessionId) {
      void unsubscribeSession(previousViewedSessionId)
        .then((record) => {
          mergeSessionRecord(record, { select: false });
        })
        .catch(() => {
          // Ignore auto-unsubscribe failures; explicit actions will surface errors.
        });
    }

    if ((activePage !== "sessions" && activePage !== "chat") || !viewedSession) {
      return;
    }

    let cancelled = false;

    if (!viewedSession.subscribed && !viewedSession.terminalAttached) {
      void subscribeSession(viewedSession.id)
        .then((record) => {
          if (!cancelled) {
            applySessionUpdate(record);
          }
        })
        .catch(async (error) => {
          if (!cancelled) {
            setSessionActionError(await reportClientError("ui.sessions.subscribe", error, "Unable to subscribe to session."));
          }
        });
    }

    setLoadingModelSessionId(viewedSession.id);

    void getSessionModelState(viewedSession.id)
      .then((state) => {
        if (cancelled) {
          return;
        }

        setModelStates((current) => ({
          ...current,
          [state.sessionId]: state,
        }));
      })
      .catch(async (error) => {
        if (!cancelled) {
          setSessionActionError(await reportClientError("ui.sessions.model_state.load", error, "Unable to load session model."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModelSessionId((current) => (current === viewedSession.id ? null : current));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePage, isDetachedWindow, viewedSession?.id, viewedSession?.subscribed, viewedSession?.terminalAttached, applySessionUpdate, mergeSessionRecord]);

  useEffect(() => {
    if (isDetachedWindow || (activePage !== "sessions" && activePage !== "chat") || !viewedSession?.id || viewedSession.status !== "active") {
      return;
    }

    let cancelled = false;

    const refreshSelectedSession = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void getSessionRecord(viewedSession.id)
        .then((record) => {
          if (!cancelled) {
            mergeSessionRecord(record, { select: false });
          }
        })
        .catch(() => {
          // Ignore refresh misses while the session runtime is reconciling.
        });
    };

    refreshSelectedSession();
    const intervalId = window.setInterval(refreshSelectedSession, 1000);
    window.addEventListener("focus", refreshSelectedSession);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshSelectedSession);
    };
  }, [activePage, isDetachedWindow, mergeSessionRecord, viewedSession?.id, viewedSession?.status]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    const node = transcriptRef.current;
    if (!node || !sessionScrollState.lockedToBottom) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [displayedEvents, isDetachedWindow, viewedSession?.id, sessionScrollState.lockedToBottom]);

  useEffect(() => {
    setSessionScrollState({ lockedToBottom: true });
  }, [viewedSession?.id]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    const handleScrollLockChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ lockedToBottom?: boolean }>;
      const lockedToBottom = customEvent.detail?.lockedToBottom ?? false;
      setSessionScrollState((current) => (current.lockedToBottom === lockedToBottom ? current : { lockedToBottom }));
    };

    node.addEventListener("orchestra:session-scroll-lock-change", handleScrollLockChange as EventListener);
    return () => node.removeEventListener("orchestra:session-scroll-lock-change", handleScrollLockChange as EventListener);
  }, [viewedSession?.id]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    const syncScrollLockState = () => {
      const lockedToBottom = isScrolledToBottom(node);
      setSessionScrollState((current) => (current.lockedToBottom === lockedToBottom ? current : { lockedToBottom }));
    };

    syncScrollLockState();
    window.addEventListener("resize", syncScrollLockState);
    return () => window.removeEventListener("resize", syncScrollLockState);
  }, [displayedEvents.length, viewedSession?.id]);

  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);
  const selectedSessionPendingRun = selectedSession ? pendingRuns[selectedSession.id] : undefined;
  const selectedModelState = selectedSession ? modelStates[selectedSession.id] : undefined;
  const selectedSessionDraftMessage = selectedSession ? draftMessages[selectedSession.id] ?? "" : "";
  const chatSessionPendingRun = chatSession ? pendingRuns[chatSession.id] : undefined;
  const chatModelState = chatSession ? modelStates[chatSession.id] : undefined;
  const chatSessionDraftMessage = chatSession ? draftMessages[chatSession.id] ?? "" : "";
  const selectedSessionDisplayStatus: SessionStatus = selectedSessionPendingRun ? "streaming" : selectedSession?.status ?? "idle";
  const chatSessionDisplayStatus: SessionStatus = chatSessionPendingRun ? "streaming" : chatSession?.status ?? "idle";

  async function handleModelChange(sessionId: string, value: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const [provider, ...modelParts] = value.split("/");
    const modelId = modelParts.join("/");
    if (!provider || !modelId) {
      return;
    }

    setSessionActionError(null);
    setChangingModelSessionId(session.id);

    try {
      const state = await setSessionModel(session.id, provider, modelId);
      setModelStates((current) => ({
        ...current,
        [state.sessionId]: state,
      }));
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to change models.");
    } finally {
      setChangingModelSessionId((current) => (current === session.id ? null : current));
    }
  }

  function navigateToTask(taskId: string) {
    setActivePage("tasks");
    setTasksOpenRequest((current) => ({ taskId, token: (current?.token ?? 0) + 1, projectId: activeProjectId }));
  }

  function navigateToTasksOverview() {
    setActivePage("tasks");
    setTasksOverviewToken((current) => current + 1);
  }

  function navigateToAgent(agentId: string) {
    setActivePage("agents");
    setAgentsSelectionRequest((current) => ({ type: "agent", id: agentId, token: (current?.token ?? 0) + 1 }));
  }

  function navigateToChatAgent(agentId: string) {
    setActivePage("chat");
    setSelectedChatAgentId(agentId);
  }

  function navigateToRole(roleId: string) {
    setActivePage("settings");
    setSettingsTab("roles");
    setRolesSelectionRequest((current) => ({ roleId, token: (current?.token ?? 0) + 1 }));
  }

  function navigateToWorkflow(workflowId: string) {
    setActivePage("settings");
    setSettingsTab("workflows");
    setWorkflowsSelectionRequest((current) => ({ workflowId, token: (current?.token ?? 0) + 1 }));
  }

  async function handleOpenAgentSession(agentId: string, options?: { openQuickChat?: boolean }) {
    setSessionActionError(null);
    try {
      const session = await ensureAgentSession(agentId, activeProject?.id ?? null);
      mergeSessionRecord(session, { select: !options?.openQuickChat });
      if (options?.openQuickChat) {
        setSupervisorSessionId(session.id);
        setSupervisorQuickChatOpen(true);
      } else {
        setActivePage("sessions");
        setSelectedSessionId(session.id);
      }
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to open agent session.");
    }
  }

  async function handleOpenAgentSessionTerminal(agentId: string) {
    setSessionActionError(null);
    try {
      const session = await openAgentSessionInTerminal(agentId, activeProject?.id ?? null);
      mergeSessionRecord(session);
      setActivePage("sessions");
      setSelectedSessionId(session.id);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to open agent terminal window.");
    }
  }

  async function refreshCommandPaletteItems() {
    setCommandPaletteLoading(true);
    try {
      const [nextSessions, nextTasks, nextAgents, nextRoles, nextWorkflows] = await Promise.all([
        listSessions(),
        listTasks(false, activeProjectId),
        listAgentOperations(false, activeProjectId),
        listRoleOperations(false),
        listWorkflows(false),
      ]);
      setSessions(nextSessions);
      setCommandPaletteItems(
        buildCommandPaletteItems({
          sessions: nextSessions,
          tasks: nextTasks,
          agents: nextAgents,
          roles: nextRoles,
          workflows: nextWorkflows,
        }),
      );
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to load command palette items.");
    } finally {
      setCommandPaletteLoading(false);
    }
  }

  function handleOpenCommandPalette() {
    setCommandPaletteOpen(true);
    void refreshCommandPaletteItems();
  }

  async function handleOpenSupervisorQuickChat() {
    setCommandPaletteOpen(false);
    await handleOpenAgentSession(SUPERVISOR_AGENT_ID, { openQuickChat: true });
  }

  async function handleCommandPaletteSelect(item: CommandPaletteItem) {
    setCommandPaletteOpen(false);

    switch (item.action.type) {
      case "navigate-page":
        setActivePage(item.action.page);
        return;
      case "navigate-settings":
        setActivePage("settings");
        setSettingsTab(item.action.tab);
        return;
      case "open-task":
        navigateToTask(item.action.taskId);
        return;
      case "open-session":
        setActivePage("sessions");
        setSelectedSessionId(item.action.sessionId);
        return;
      case "open-agent":
        navigateToAgent(item.action.agentId);
        return;
      case "open-role":
        navigateToRole(item.action.roleId);
        return;
      case "open-workflow":
        navigateToWorkflow(item.action.workflowId);
        return;
      case "create-task":
        setActivePage("tasks");
        setTasksCreateProjectId(activeProjectId ?? "orchestra");
        setTasksCreateToken((current) => current + 1);
        return;
      case "create-session":
        setActivePage("sessions");
        await runSessionAction(async () => createSession(undefined, activeProject?.slug ?? null));
        return;
      case "open-logs":
        await handleOpenLogsWindow();
        return;
      case "open-supervisor-chat":
        await handleOpenSupervisorQuickChat();
        return;
      case "launch-agent-session":
        await handleOpenAgentSession(item.action.agentId);
        return;
      case "launch-agent-session-terminal":
        await handleOpenAgentSessionTerminal(item.action.agentId);
        return;
      default:
        return;
    }
  }

  function handleStopSession(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const timestamp = nowIso();
    setSessionActionError(null);

    void stopSessionRuntime(sessionId)
      .then((record: SessionRecord) => {
        removePendingRun(sessionId);
        mergeSessionRecord({
          ...record,
          status: "paused",
          updatedAt: timestamp,
          events: [
            ...record.events,
            {
              id: `client-stop-${sessionId}-${timestamp}`,
              kind: "system",
              message: "Session run stopped by operator.",
              timestamp,
            },
          ],
        });
      })
      .catch(async (error: unknown) => {
        setSessionActionError(await reportClientError("ui.sessions.stop", error, "Unable to stop session runtime."));
      });
  }

  function handleSendMessage(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const trimmedMessage = (draftMessages[sessionId] ?? "").trim();
    if (!trimmedMessage) {
      return;
    }

    const runId = createClientId("run");
    const timestamp = nowIso();

    const pendingUserEvent: SessionEvent = {
      id: `pending-user-${runId}`,
      kind: "user",
      message: trimmedMessage,
      timestamp,
      pending: true,
      runId,
    };

    setSessionActionError(null);
    updateDraftMessage(sessionId, "");
    setPendingRuns((current) => ({
      ...current,
      [sessionId]: {
        runId,
        userEvent: pendingUserEvent,
      },
    }));
    patchSessionRecord(sessionId, (record) => ({
      ...record,
      status: "streaming",
      updatedAt: timestamp,
      events: [...record.events.filter((event) => event.runId !== runId), pendingUserEvent],
    }));

    void sendSessionMessage(sessionId, trimmedMessage, runId).catch(async (error) => {
      patchSessionRecord(sessionId, (record) => ({
        ...record,
        status: "failed",
        events: record.events.filter((event) => event.runId !== runId),
      }));
      removePendingRun(sessionId, runId);
      updateDraftMessage(sessionId, trimmedMessage);
      setSessionActionError(await reportClientError("ui.sessions.message.queue", error, "Unable to queue message."));
    });
  }

  useEffect(() => {
    if (isLogsWindow) {
      return;
    }

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.repeat) {
        return;
      }

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        handleOpenCommandPalette();
      }

      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        void handleOpenSupervisorQuickChat();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [isDetachedWindow, sessions, draftMessages, pendingRuns]);

  useEffect(() => {
    const handleUnhandledError = (event: ErrorEvent) => {
      void reportClientError("ui.unhandled_error", event.error ?? event.message, "Unhandled UI error.");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      void reportClientError("ui.unhandled_rejection", event.reason, "Unhandled promise rejection.");
    };

    window.addEventListener("error", handleUnhandledError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleUnhandledError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  if (isLogsWindow) {
    return (
      <main className="logs-window-shell">
        <header className="logs-window-header">
          <div>
            <p className="eyebrow">Orchestra diagnostics</p>
            <h1>Logs</h1>
          </div>

        </header>

        <RuntimeLogPanel
          logs={logs}
          loadingLogs={loadingLogs}
          clearingLogs={clearingLogs}
          exportingLogs={exportingLogs}
          exportStatusMessage={logExportMessage}
          exportErrorMessage={logExportError}
          includeRelatedSessionSnapshot={includeRelatedSessionSnapshot}
          onRefresh={() => void loadLogs()}
          onToggleIncludeRelatedSessionSnapshot={setIncludeRelatedSessionSnapshot}
          onExport={() => void handleExportLogsBundle()}
          onClear={() => void handleClearLogs()}
        />
      </main>
    );
  }

  if (isAgentTerminalWindow && agentTerminalSessionId) {
    return <AgentTerminalWindowPage sessionId={agentTerminalSessionId} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="project-switcher">
            <span className="project-switcher__label">Project</span>
            <select
              className="project-switcher__button"
              data-role="project-switcher"
              value={activeProject?.id ?? ""}
              onChange={(event) => setActiveProjectIdState(event.target.value || null)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <nav className="primary-nav" aria-label="Primary">
            {activeNavItems.map((item) => (
              item.id === "chat" ? (
                <div className="settings-nav" key={item.id}>
                  <button
                    className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                    type="button"
                    onClick={() => setActivePage(item.id)}
                  >
                    {item.label}
                  </button>

                  {activePage === "chat" ? (
                    <div className="settings-subnav" role="tablist" aria-label="Chat agents">
                      {loadingChatAgents ? <span className="settings-subnav__hint">Loading agents…</span> : null}
                      {!loadingChatAgents && chatAgents.length === 0 ? <span className="settings-subnav__hint">No agents yet.</span> : null}
                      {chatAgents.map((agentSnapshot) => (
                        <button
                          key={agentSnapshot.agent.id}
                          className={selectedChatAgentId === agentSnapshot.agent.id ? "settings-subnav__item settings-subnav__item--active" : "settings-subnav__item"}
                          type="button"
                          role="tab"
                          aria-selected={selectedChatAgentId === agentSnapshot.agent.id}
                          data-role={`chat-agent-nav-${agentSnapshot.agent.slug}`}
                          onClick={() => navigateToChatAgent(agentSnapshot.agent.id)}
                        >
                          {agentSnapshot.agent.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <button
                  key={item.id}
                  className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                  type="button"
                  onClick={() => {
                    if (item.id === "tasks") {
                      navigateToTasksOverview();
                      return;
                    }
                    setActivePage(item.id);
                  }}
                >
                  {item.label}
                </button>
              )
            ))}
          </nav>
        </div>

        <div className="sidebar__bottom">
          <div className="settings-nav">
            <button
              className={activePage === "settings" ? "nav-item nav-item--active" : "nav-item"}
              type="button"
              onClick={() => setActivePage("settings")}
            >
              Settings
            </button>

            {activePage === "settings" ? (
              <div className="settings-subnav" role="tablist" aria-label="Settings sections">
                {SETTINGS_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    className={settingsTab === tab.id ? "settings-subnav__item settings-subnav__item--active" : "settings-subnav__item"}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                    onClick={() => setSettingsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="page-header page-header--compact">
          <div className="page-header__leading">
            <p className="page-version-label muted-copy" data-role="app-version-label">
              {appInfo?.versionDisplay ?? "loading-version"}
            </p>
            {activePage === "sessions" ? (
              <button
                className="primary-button"
                data-role="create-session"
                type="button"
                disabled={isSubmitting || Boolean(appInfo?.dispatchBlocked)}
                onClick={() =>
                  void runSessionAction(async () => createSession(undefined, activeProject?.slug ?? null))
                }
              >
                Create session
              </button>
            ) : activePage === "tasks" ? (
              <button
                className="primary-button"
                data-role="new-task"
                type="button"
                onClick={() => {
                  setTasksCreateProjectId(activeProjectId);
                  setTasksCreateToken((current) => current + 1);
                }}
              >
                New task
              </button>
            ) : null}
          </div>
          <div className="status-cluster">
            <button className="secondary-button" data-role="open-command-palette" type="button" onClick={() => handleOpenCommandPalette()}>
              Search · Ctrl+O
            </button>
            <button className="secondary-button" data-role="open-supervisor-quick-chat" type="button" onClick={() => void handleOpenSupervisorQuickChat()}>
              Supervisor · Ctrl+T
            </button>
            <button className="secondary-button" type="button" onClick={() => void handleOpenLogsWindow()}>
              Open logs
            </button>
          </div>
        </header>

        {appInfo?.dispatchBlockedReason ? (
          <div className="session-readonly-banner app-status-banner" data-role="dispatch-blocked-banner">
            <div>
              <strong>Dispatching disabled.</strong> {appInfo.dispatchBlockedReason}
            </div>
            <button className="secondary-button" type="button" data-role="retry-pi-health-check" onClick={() => void loadAppInfo()}>
              Retry check
            </button>
          </div>
        ) : null}

        {activePage === "settings" ? (
          settingsTab === "projects" ? (
            <ProjectsPanel />
          ) : settingsTab === "agents" ? (
            <AgentsPanel activeProjectId={activeProject?.id ?? null} />
          ) : settingsTab === "roles" ? (
            <RolesPanel selectionRequest={rolesSelectionRequest} />
          ) : settingsTab === "workflows" ? (
            <WorkflowsPanel activeProjectId={activeProject?.id ?? null} selectionRequest={workflowsSelectionRequest} />
          ) : settingsTab === "channels" ? (
            <ChannelsPanel />
          ) : (
            <GeneralPanel
              bridgeDiagnostics={bridgeDiagnostics}
              sessionPromptSettings={sessionPromptSettings}
              loadingBridgeDiagnostics={loadingBridgeDiagnostics}
              refreshingBridgeDiagnostics={refreshingBridgeDiagnostics}
              logs={logs}
              loadingLogs={loadingLogs}
              clearingLogs={clearingLogs}
              exportingLogs={exportingLogs}
              logExportMessage={logExportMessage}
              logExportError={logExportError}
              includeRelatedSessionSnapshot={includeRelatedSessionSnapshot}
              onRefreshBridgeDiagnostics={() => void loadBridgeDiagnostics({ background: true })}
              onCleanupStaleBridges={() => void handleCleanupStaleBridges()}
              onOpenLogsWindow={() => void handleOpenLogsWindow()}
              onSaveSessionPromptTemplate={(template) => void handleSaveSessionPromptTemplate(template)}
              onRefreshLogs={() => void loadLogs()}
              onToggleIncludeRelatedSessionSnapshot={setIncludeRelatedSessionSnapshot}
              onExportLogs={() => void handleExportLogsBundle()}
              onClearLogs={() => void handleClearLogs()}
            />
          )
        ) : activePage === "inbox" ? (
          <InboxPage
            key={activeProject?.id ?? "default"}
            projectId={activeProject?.id ?? null}
            onOpenTask={navigateToTask}
          />
        ) : activePage === "agents" ? (
          <AgentsPage
            key={activeProject?.id ?? "default"}
            activeProjectId={activeProject?.id ?? null}
            onOpenAgentSession={(agentId) => void handleOpenAgentSession(agentId)}
            onOpenAgentSessionTerminal={(agentId) => void handleOpenAgentSessionTerminal(agentId)}
            selectedWorkerRequest={agentsSelectionRequest}
          />
        ) : activePage === "chat" ? (
          <AgentChatPage
            agent={selectedChatAgent}
            session={chatSession}
            displayedEvents={displayedEvents}
            sessionPending={Boolean(chatSessionPendingRun)}
            sessionDisplayStatus={chatSessionDisplayStatus}
            selectedModelState={chatModelState}
            sessionReadOnly={Boolean(chatSession?.terminalAttached)}
            loadingAgents={loadingChatAgents}
            loadingSession={Boolean(selectedChatAgent && loadingChatSessionAgentId === selectedChatAgent.id && !chatSession)}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={chatSessionDraftMessage}
            error={sessionActionError}
            transcriptRef={transcriptRef}
            scrollState={sessionScrollState}
            formatDateTime={formatDateTime}
            formatTimestamp={formatTimestamp}
            formatModelOptionLabel={formatModelOptionLabel}
            getStatusTone={getStatusTone}
            getEventTone={getEventTone}
            onModelChange={(value) => {
              if (chatSession) {
                void handleModelChange(chatSession.id, value);
              }
            }}
            onDraftChange={(value) => {
              if (chatSession) {
                updateDraftMessage(chatSession.id, value);
              }
            }}
            onSendMessage={() => {
              if (chatSession?.terminalAttached) {
                return;
              }
              if (chatSession) {
                handleSendMessage(chatSession.id);
              }
            }}
            onStopSession={() => {
              if (chatSession) {
                handleStopSession(chatSession.id);
              }
            }}
          />
        ) : activePage === "sessions" ? (
          <SessionsPage
            sessions={filteredSessions}
            sessionFilter={sessionFilter}
            onSessionFilterChange={setSessionFilter}
            selectedSession={selectedSession}
            displayedEvents={selectedSession?.events ?? []}
            selectedSessionPending={Boolean(selectedSessionPendingRun)}
            selectedSessionDisplayStatus={selectedSessionDisplayStatus}
            selectedModelState={selectedModelState}
            selectedSessionReadOnly={Boolean(selectedSession?.terminalAttached)}
            loadingSessions={loadingSessions}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={selectedSessionDraftMessage}
            sessionActionError={sessionActionError}
            transcriptRef={transcriptRef}
            scrollState={sessionScrollState}
            formatDateTime={formatDateTime}
            formatTimestamp={formatTimestamp}
            formatModelOptionLabel={formatModelOptionLabel}
            getStatusTone={getStatusTone}
            getEventTone={getEventTone}
            onSelectSession={setSelectedSessionId}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
            onDeleteClosedSessions={() => void handleDeleteClosedSessions()}
            onModelChange={(value) => {
              if (selectedSession) {
                void handleModelChange(selectedSession.id, value);
              }
            }}
            onDraftChange={(value) => {
              if (selectedSession) {
                updateDraftMessage(selectedSession.id, value);
              }
            }}
            onSendMessage={() => {
              if (selectedSession?.terminalAttached) {
                return;
              }
              if (selectedSession) {
                handleSendMessage(selectedSession.id);
              }
            }}
            onStopSession={() => {
              if (selectedSession) {
                handleStopSession(selectedSession.id);
              }
            }}
          />
        ) : (
          <TasksPage
            createTaskProjectId={tasksCreateProjectId}
            createTaskToken={tasksCreateToken}
            key={activeProject?.id ?? "default"}
            openTaskRequest={tasksOpenRequest}
            projectId={activeProject?.id ?? null}
            taskBoardViewMode={taskBoardViewMode}
            tasksOverviewToken={tasksOverviewToken}
            onTaskBoardViewModeChange={handleTaskBoardViewModeChange}
          />
        )}
      </main>

      <CommandPalette
        items={commandPaletteItems}
        loading={commandPaletteLoading}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(item) => void handleCommandPaletteSelect(item)}
        open={commandPaletteOpen}
      />
      <SupervisorQuickChatModal
        draftMessage={supervisorSessionDraftMessage}
        error={sessionActionError}
        events={supervisorSession?.events ?? []}
        formatTimestamp={formatTimestamp}
        onClose={() => setSupervisorQuickChatOpen(false)}
        onDraftChange={(value) => {
          if (supervisorSession) {
            updateDraftMessage(supervisorSession.id, value);
          }
        }}
        onOpenFullSession={() => {
          if (supervisorSession) {
            setActivePage("sessions");
            setSelectedSessionId(supervisorSession.id);
            setSupervisorQuickChatOpen(false);
          }
        }}
        onSend={() => {
          if (supervisorSession) {
            handleSendMessage(supervisorSession.id);
          }
        }}
        open={supervisorQuickChatOpen}
        pending={Boolean(supervisorPendingRun)}
        session={supervisorSession}
      />
    </div>
  );
}
