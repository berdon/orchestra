import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ensureAgentSession, listAgentOperations, listAgents } from "./lib/agents";
import { buildCommandPaletteItems, type CommandPaletteItem } from "./lib/commandPalette";
import { applyPendingRunToSession, createPendingUserRun, type PendingSessionRun, reduceSessionTranscriptEvent } from "./lib/sessionTranscriptReducer";
import { sortSessionRecords } from "./lib/sessionList";
import { reconcileListedSessions } from "./lib/sessionListMerge";
import { getActiveProjectId, setActiveProjectId } from "./lib/projects";
import { listRoleOperations } from "./lib/roleRuntime";
import { listRoles } from "./lib/roles";
import { getSessionPromptSettings, updateSessionPromptSettings } from "./lib/projectSettings";
import { listenToAgentCatalogChanges } from "./lib/agentCatalogEvents";
import { BUILT_IN_ORCHESTRA_THEMES, applyOrchestraTheme, getOrchestraThemeDefinition, loadStoredOrchestraTheme, storeOrchestraTheme, type OrchestraThemeId } from "./lib/theme";
import {
  ExplanatoryTooltipsProvider,
  applyExplanatoryTooltips,
  getExplanatoryTooltipProps,
  loadStoredExplanatoryTooltips,
  storeExplanatoryTooltips,
} from "./lib/tooltips";
import { ConnectionStatusBanner } from "./components/ConnectionStatusBanner";
import { useProjectReferenceData, useProjectUnreadCounts } from "./lib/orchestraData/appShell";
import { useOrchestraConnection } from "./lib/orchestraData/connection";
import { reportUiError, toUiErrorState, type UiErrorState } from "./lib/orchestraData/errors";
import { useNotificationController } from "./lib/orchestraData/notifications";
import { useSessionEventRefresh, useSessionPollingRefresh } from "./lib/orchestraData/sessions";
import {
  defaultOrchestraShellWindowState,
  supportsAgentTerminal,
  supportsBridgeDiagnostics,
  supportsHarnessSettings,
  supportsLogsWindow,
  supportsRemoteAccess,
  supportsRuntimeLogs,
  supportsSystemNotifications,
  retryOrchestraRead,
  useOrchestraBootstrap,
  useOrchestraClient,
} from "./lib/orchestraClient";
import { AgentsPage } from "./agents/AgentsPage";
import { CommandPalette } from "./components/CommandPalette";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { RuntimeLogPanel } from "./components/RuntimeLogPanel";
import { SupervisorQuickChatModal } from "./components/SupervisorQuickChatModal";
import { TaskActionMenu } from "./components/TaskActionMenu";
import { InboxPage } from "./pages/InboxPage";
import { AgentChatPage } from "./pages/AgentChatPage";
import { AgentTerminalWindowPage } from "./pages/AgentTerminalWindowPage";
import { shouldApplyChatAgentLoad } from "./pages/chat/chatAgentLoadGuards";
import { SessionsPage } from "./pages/SessionsPage";
import { TasksPage, type TasksMobileHeaderContext } from "./pages/TasksPage";
import {
  buildTaskOverviewStateForTagNavigation,
  loadStoredTaskOverviewState,
  storeTaskOverviewState,
  type TaskOverviewState,
} from "./pages/tasks/taskOverviewState";
import { loadStoredLocalNotificationsEnabled, storeLocalNotificationsEnabled } from "./lib/localNotifications";
import { AgentsPanel } from "./settings/AgentsPanel";
import { ChannelsPanel } from "./settings/ChannelsPanel";
import { ProjectsPanel } from "./settings/ProjectsPanel";
import { RolesPanel } from "./settings/RolesPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { HarnessPanel } from "./settings/HarnessPanel";
import { PromptingPanel } from "./settings/PromptingPanel";
import { RemotePanel } from "./settings/RemotePanel";
import { SourceControlPanel } from "./settings/SourceControlPanel";
import { SkillsPanel } from "./settings/SkillsPanel";
import { WorkflowsPanel } from "./settings/WorkflowsPanel";
import type {
  AgentOperationsSnapshot,
  AgentSummary,
  AppInfo,
  BridgeDiagnostics,
  JsonValue,
  LogEntry,
  PiOAuthFlowState,
  PiRuntimeSettings,
  PiSetupState,
  ProjectSessionPromptSettings,
  PrimaryPage,
  SystemNotificationEnvironmentStatus,
  SystemNotificationPermissionState,
  ProjectSummary,
  RoleOperationsSnapshot,
  RoleSummary,
  SessionActivityState,
  SessionEvent,
  SessionListVisibility,
  SessionMessageability,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionStats,
  SessionScrollState,
  SessionStatus,
  SessionStreamEnvelope,
  SettingsTab,
  TaskSummary,
  WorkflowSummary,
} from "./types";

const COMMAND_PALETTE_SOURCE_TIMEOUT_MS = 4_000;

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "inbox", label: "Inbox" },
  { id: "agents", label: "Agents" },
  { id: "chat", label: "Chat" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

function NavIcon({ pageId, className }: { pageId: PrimaryPage; className?: string }) {
  switch (pageId) {
    case "tasks":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="4" width="13" height="12.5" rx="2.5" />
          <path d="M6.75 7.25h6.5" />
          <path d="M6.75 10h6.5" />
          <path d="M6.75 12.75h4.25" />
        </svg>
      );
    case "inbox":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6.5 6.1 4h7.8L16 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5Z" />
          <path d="M4 11.25h3l1.25 2h3.5l1.25-2H16" />
        </svg>
      );
    case "agents":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7.25 9a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" />
          <path d="M12.9 10.15a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z" />
          <path d="M4.75 14.75a3.35 3.35 0 0 1 5 0" />
          <path d="M11.1 14.5a2.9 2.9 0 0 1 4.15 0" />
        </svg>
      );
    case "chat":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.25 5h9.5A1.75 1.75 0 0 1 16.5 6.75v5.5A1.75 1.75 0 0 1 14.75 14H9.5L6 16.5V14H5.25A1.75 1.75 0 0 1 3.5 12.25v-5.5A1.75 1.75 0 0 1 5.25 5Z" />
          <path d="M6.75 8.5h6.5" />
          <path d="M6.75 11h4.5" />
        </svg>
      );
    case "sessions":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.75" y="4" width="12.5" height="12" rx="2.5" />
          <path d="M7 8.25h6" />
          <path d="M7 11h6" />
          <path d="M7 13.75h3.5" />
        </svg>
      );
    case "settings":
      return (
        <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 4.25v1.4" />
          <path d="M10 14.35v1.4" />
          <path d="M5.93 5.93l.99.99" />
          <path d="m13.08 13.08.99.99" />
          <path d="M4.25 10h1.4" />
          <path d="M14.35 10h1.4" />
          <path d="m5.93 14.07.99-.99" />
          <path d="m13.08 6.92.99-.99" />
          <circle cx="10" cy="10" r="2.85" />
        </svg>
      );
    default:
      return null;
  }
}

const SETTINGS_TABS = [
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "roles", label: "Roles" },
  { id: "workflows", label: "Workflows" },
  { id: "skills", label: "Skills" },
  { id: "channels", label: "Channels" },
  { id: "remote", label: "Remote" },
  { id: "source_control", label: "Source Control" },
  { id: "prompting", label: "Prompting" },
  { id: "harness", label: "Harness" },
  { id: "general", label: "General" },
] as const;

const SUPERVISOR_AGENT_ID = "agent-supervisor";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "orchestra.preferences.sidebar-collapsed";
const CHAT_SESSION_RECOVERY_GRACE_MS = 60_000;
const APP_ROUTE_PAGES = new Set<PrimaryPage>(["tasks", "inbox", "agents", "chat", "sessions", "settings"]);
const APP_ROUTE_SETTINGS_TABS = new Set<SettingsTab>(SETTINGS_TABS.map((tab) => tab.id));
const MOBILE_NAVIGATION_BREAKPOINT_PX = 900;
const MOBILE_NAVIGATION_MEDIA_QUERY = `(max-width: ${MOBILE_NAVIGATION_BREAKPOINT_PX}px)`;
const MOBILE_NAVIGATION_DIALOG_ID = "mobile-navigation-sheet";

function isMobileNavigationViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(MOBILE_NAVIGATION_MEDIA_QUERY).matches;
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return [] as HTMLElement[];
  }

  return Array.from(container.querySelectorAll<HTMLElement>([
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    return element.offsetParent !== null || document.activeElement === element;
  });
}

type AppSelectionRouteState = {
  page: PrimaryPage;
  projectId: string | null;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  settingsTab: SettingsTab | null;
};

function getInitialAppSelectionRouteState(): AppSelectionRouteState {
  const defaultRoute: AppSelectionRouteState = {
    page: "sessions",
    projectId: getActiveProjectId(),
    selectedTaskId: null,
    selectedSessionId: null,
    settingsTab: null,
  };

  if (typeof window === "undefined") {
    return defaultRoute;
  }

  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "logs" || view === "agent-terminal") {
    return defaultRoute;
  }

  const pageParam = params.get("page");
  const selectedTaskId = params.get("selectedTaskId");
  const selectedSessionId = params.get("selectedSessionId");
  const settingsTabParam = params.get("settingsTab");
  const page = pageParam && APP_ROUTE_PAGES.has(pageParam as PrimaryPage)
    ? pageParam as PrimaryPage
    : selectedTaskId
      ? "tasks"
      : selectedSessionId
        ? "sessions"
        : "sessions";

  return {
    page,
    projectId: params.get("projectId") ?? defaultRoute.projectId,
    selectedTaskId,
    selectedSessionId,
    settingsTab: settingsTabParam && APP_ROUTE_SETTINGS_TABS.has(settingsTabParam as SettingsTab)
      ? settingsTabParam as SettingsTab
      : null,
  };
}

function setSearchParam(params: URLSearchParams, key: string, value: string | null | undefined) {
  if (value && value.length > 0) {
    params.set(key, value);
    return;
  }
  params.delete(key);
}

function loadStoredSidebarCollapsed() {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

function supervisorQuickChatStorageKey(projectId: string | null) {
  return `orchestra.quick-chat.supervisor.${projectId ?? "default"}`;
}

function buildPendingAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: `pending-assistant-${runId}`,
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    thinkingText: "",
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

function formatNavigationBadgeCount(count: number) {
  if (count <= 0) {
    return "";
  }
  if (count > 99) {
    return "99+";
  }
  return String(count);
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

function asNumber(value: JsonValue | undefined | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractRpcMessageBlocks(message: JsonValue | undefined | null, expectedType: string, valueKey: string) {
  if (!isObject(message)) {
    return "";
  }

  return asArray(message.content)
    .map((block) => {
      if (!isObject(block) || asString(block.type) !== expectedType) {
        return "";
      }

      return asString(block[valueKey]);
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractRpcMessageText(message: JsonValue | undefined | null) {
  return extractRpcMessageBlocks(message, "text", "text");
}

function extractRpcThinkingText(message: JsonValue | undefined | null) {
  return extractRpcMessageBlocks(message, "thinking", "thinking");
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
    thinkingText: "",
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

function getAssistantToolCallDetails(message: JsonValue | undefined | null, contentIndex?: number) {
  if (!isObject(message)) {
    return null;
  }

  const content = asArray(message.content);
  const index = typeof contentIndex === "number" ? contentIndex : -1;
  const candidate = index >= 0 && index < content.length ? content[index] : null;
  const toolBlock = [candidate, ...content].find((block) => {
    if (!isObject(block)) {
      return false;
    }
    const type = asString(block.type).replace(/[_-]/g, "").toLowerCase();
    return type === "toolcall" || type === "tooluse";
  });

  if (!isObject(toolBlock)) {
    return null;
  }

  const toolName = asString(toolBlock.toolName) || asString(toolBlock.name) || "tool";
  const toolCallId = asString(toolBlock.toolCallId) || asString(toolBlock.id) || `tool-call-${toolName}`;
  const args = toolBlock.input ?? toolBlock.args ?? toolBlock.arguments ?? toolBlock.parameters ?? null;
  return {
    toolName,
    toolCallId,
    args,
    label: formatToolCallLabel(toolName, args),
  };
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

function deriveSessionListVisibility(session: SessionRecord): SessionListVisibility {
  return session.status === "closed" ? "closed" : "active";
}

function deriveSessionMessageability(session: SessionRecord): SessionMessageability {
  return session.status === "closed" ? "closed" : "messageable";
}

function getSessionListVisibility(session: SessionRecord): SessionListVisibility {
  return session.listVisibility ?? deriveSessionListVisibility(session);
}

function getSessionMessageability(session: SessionRecord): SessionMessageability {
  return session.messageability ?? deriveSessionMessageability(session);
}

function isSessionVisibleInList(session: SessionRecord) {
  return getSessionListVisibility(session) !== "hidden";
}

function isSessionClosedInList(session: SessionRecord) {
  return getSessionListVisibility(session) === "closed";
}

function isSessionMessageable(session: SessionRecord) {
  return getSessionMessageability(session) === "messageable";
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    terminalAttached: session.terminalAttached ?? false,
    activityState: session.activityState ?? deriveSessionActivityState(session),
    lastActivityAt: session.lastActivityAt ?? session.updatedAt,
    taskId: session.taskId ?? null,
    taskProjectId: session.taskProjectId ?? null,
    taskNumber: session.taskNumber ?? null,
    taskTitle: session.taskTitle ?? null,
    activeTaskId: session.activeTaskId ?? null,
    activeTaskProjectId: session.activeTaskProjectId ?? null,
    activeTaskNumber: session.activeTaskNumber ?? null,
    activeTaskTitle: session.activeTaskTitle ?? null,
    workerType: session.workerType ?? null,
    workerName: session.workerName ?? null,
    listVisibility: session.listVisibility ?? deriveSessionListVisibility(session),
    messageability: session.messageability ?? deriveSessionMessageability(session),
    controlCapabilities: session.controlCapabilities ?? null,
    controlOperation: session.controlOperation ?? null,
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
      && event.presentation === other.presentation
      && event.thinkingText === other.thinkingText;
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

function areSessionMetadataEqual(left: SessionRecord, right: SessionRecord) {
  return left.taskId === right.taskId
    && left.taskProjectId === right.taskProjectId
    && left.taskNumber === right.taskNumber
    && left.taskTitle === right.taskTitle
    && left.activeTaskId === right.activeTaskId
    && left.activeTaskProjectId === right.activeTaskProjectId
    && left.activeTaskNumber === right.activeTaskNumber
    && left.activeTaskTitle === right.activeTaskTitle
    && left.workerType === right.workerType
    && left.workerName === right.workerName
    && left.listVisibility === right.listVisibility
    && left.messageability === right.messageability
    && left.controlCapabilities?.reload.status === right.controlCapabilities?.reload.status
    && left.controlCapabilities?.reload.reason === right.controlCapabilities?.reload.reason
    && left.controlCapabilities?.compact.status === right.controlCapabilities?.compact.status
    && left.controlCapabilities?.compact.reason === right.controlCapabilities?.compact.reason
    && left.controlCapabilities?.autoCompact.status === right.controlCapabilities?.autoCompact.status
    && left.controlCapabilities?.autoCompact.reason === right.controlCapabilities?.autoCompact.reason
    && left.controlCapabilities?.effectiveCompactionWindow === right.controlCapabilities?.effectiveCompactionWindow
    && left.controlCapabilities?.effectiveCompactionWindowSource === right.controlCapabilities?.effectiveCompactionWindowSource
    && left.controlOperation?.kind === right.controlOperation?.kind
    && left.controlOperation?.trigger === right.controlOperation?.trigger
    && left.controlOperation?.status === right.controlOperation?.status
    && left.controlOperation?.startedAt === right.controlOperation?.startedAt
    && left.controlOperation?.finishedAt === right.controlOperation?.finishedAt
    && left.controlOperation?.message === right.controlOperation?.message;
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
    && areSessionMetadataEqual(left, right)
    && areSessionEventsEqual(left.events, right.events);
}

function areSessionListsEqual(left: SessionRecord[], right: SessionRecord[]) {
  return left.length === right.length && left.every((session, index) => {
    const other = right[index];
    return Boolean(other) && areSessionRecordsEqual(session, other);
  });
}

export function App() {
  const initialRouteStateRef = useRef<AppSelectionRouteState | null>(null);
  if (!initialRouteStateRef.current) {
    initialRouteStateRef.current = getInitialAppSelectionRouteState();
  }
  const initialRouteState = initialRouteStateRef.current as AppSelectionRouteState;

  const orchestraClient = useOrchestraClient();
  const orchestraBootstrap = useOrchestraBootstrap();
  const connection = useOrchestraConnection();
  const shellExtension = orchestraClient.shell;
  const notificationsExtension = orchestraClient.notifications;
  const hostAdminExtension = orchestraClient.hostAdmin;
  const initialShellWindowState = shellExtension?.getInitialWindowState() ?? defaultOrchestraShellWindowState();
  const canOpenLogsWindow = supportsLogsWindow(orchestraClient, orchestraBootstrap);
  const canUseAgentTerminal = supportsAgentTerminal(orchestraClient, orchestraBootstrap);
  const canManageRuntimeLogs = supportsRuntimeLogs(orchestraClient, orchestraBootstrap);
  const canManageBridgeDiagnostics = supportsBridgeDiagnostics(orchestraClient, orchestraBootstrap);
  const canManageHarnessSettings = supportsHarnessSettings(orchestraClient, orchestraBootstrap);
  const canManageSkillsSettings = orchestraBootstrap.hostKind === "tauri";
  const canManageRemoteAccess = supportsRemoteAccess(orchestraClient, orchestraBootstrap);
  const canManageSystemNotifications = supportsSystemNotifications(orchestraClient);

  const [activePage, setActivePage] = useState<PrimaryPage>(initialRouteState.page);
  const [sessionFilter, setSessionFilter] = useState<"active" | "closed">("active");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialRouteState.settingsTab ?? "projects");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(initialRouteState.projectId);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(orchestraBootstrap.appInfo ?? null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bridgeDiagnostics, setBridgeDiagnostics] = useState<BridgeDiagnostics | null>(null);
  const [sessionPromptSettings, setSessionPromptSettings] = useState<ProjectSessionPromptSettings | null>(null);
  const [piRuntimeSettings, setPiRuntimeSettings] = useState<PiRuntimeSettings | null>(null);
  const [piSetupState, setPiSetupState] = useState<PiSetupState | null>(null);
  const [piOAuthFlowState, setPiOAuthFlowState] = useState<PiOAuthFlowState | null>(null);
  const [piModelsJson, setPiModelsJson] = useState('{\n  "providers": {}\n}\n');
  const [loadingPiSetup, setLoadingPiSetup] = useState(false);
  const [loadingPiModelsJson, setLoadingPiModelsJson] = useState(false);
  const [systemNotificationEnvironment, setSystemNotificationEnvironment] = useState<SystemNotificationEnvironmentStatus | null>(null);
  const [systemNotificationPermission, setSystemNotificationPermission] = useState<SystemNotificationPermissionState>("unsupported");
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [logExportMessage, setLogExportMessage] = useState<string | null>(null);
  const [logExportError, setLogExportError] = useState<string | null>(null);
  const [includeRelatedSessionSnapshot, setIncludeRelatedSessionSnapshot] = useState(false);
  const [loadingBridgeDiagnostics, setLoadingBridgeDiagnostics] = useState(false);
  const [refreshingBridgeDiagnostics, setRefreshingBridgeDiagnostics] = useState(false);
  const [refreshingSystemNotificationPermission, setRefreshingSystemNotificationPermission] = useState(false);
  const [requestingSystemNotificationPermission, setRequestingSystemNotificationPermission] = useState(false);
  const [sendingTestSystemNotification, setSendingTestSystemNotification] = useState(false);
  const [isLogsWindow, setIsLogsWindow] = useState(() => initialShellWindowState.isLogsWindow);
  const [isAgentTerminalWindow, setIsAgentTerminalWindow] = useState(() => initialShellWindowState.isAgentTerminalWindow);
  const [agentTerminalSessionId, setAgentTerminalSessionId] = useState<string | null>(() => initialShellWindowState.agentTerminalSessionId);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialRouteState.selectedSessionId);
  const [chatAgents, setChatAgents] = useState<AgentOperationsSnapshot[]>([]);
  const [selectedChatAgentId, setSelectedChatAgentId] = useState<string | null>(null);
  const [themeId, setThemeId] = useState<OrchestraThemeId>(() => loadStoredOrchestraTheme());
  const [explanatoryTooltipsEnabled, setExplanatoryTooltipsEnabled] = useState(() => loadStoredExplanatoryTooltips());
  const [localNotificationsEnabled, setLocalNotificationsEnabled] = useState(() => loadStoredLocalNotificationsEnabled());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => loadStoredSidebarCollapsed());
  const [isMobileNavigation, setIsMobileNavigation] = useState(() => isMobileNavigationViewport());
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [loadingChatAgents, setLoadingChatAgents] = useState(false);
  const [loadingChatSessionAgentId, setLoadingChatSessionAgentId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<UiErrorState | null>(null);
  const [draftMessages, setDraftMessages] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingSessionRun>>({});
  const [modelStates, setModelStates] = useState<Record<string, SessionModelState>>({});
  const [sessionStats, setSessionStats] = useState<Record<string, SessionStats>>({});
  const [loadingModelSessionId, setLoadingModelSessionId] = useState<string | null>(null);
  const [loadingStatsSessionId, setLoadingStatsSessionId] = useState<string | null>(null);
  const [changingModelSessionId, setChangingModelSessionId] = useState<string | null>(null);
  const [loadingRuntimeDetailsSessionId, setLoadingRuntimeDetailsSessionId] = useState<string | null>(null);
  const [sessionScrollState, setSessionScrollState] = useState<SessionScrollState>({ lockedToBottom: true });
  const [tasksCreateToken, setTasksCreateToken] = useState(0);
  const [tasksCreateProjectId, setTasksCreateProjectId] = useState<string | null>(null);
  const [taskOverviewState, setTaskOverviewState] = useState<TaskOverviewState>(() => loadStoredTaskOverviewState(initialRouteState.projectId));
  const [tasksOverviewToken, setTasksOverviewToken] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialRouteState.selectedTaskId);
  const [tasksOpenRequest, setTasksOpenRequest] = useState<{ taskId: string; token: number; projectId: string | null } | null>(
    initialRouteState.selectedTaskId
      ? { taskId: initialRouteState.selectedTaskId, token: 1, projectId: initialRouteState.projectId }
      : null,
  );
  const [pendingSessionOpenRequest, setPendingSessionOpenRequest] = useState<{ sessionId: string; token: number; projectId: string | null } | null>(
    initialRouteState.selectedSessionId
      ? { sessionId: initialRouteState.selectedSessionId, token: 1, projectId: initialRouteState.projectId }
      : null,
  );
  const [agentsSelectionRequest, setAgentsSelectionRequest] = useState<{ type: "role" | "agent"; id: string; token: number } | null>(null);
  const [rolesSelectionRequest, setRolesSelectionRequest] = useState<{ roleId: string; token: number } | null>(null);
  const [workflowsSelectionRequest, setWorkflowsSelectionRequest] = useState<{ workflowId: string; token: number } | null>(null);
  const [skillsSelectionRequest, setSkillsSelectionRequest] = useState<{ skillId: string; token: number } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteLoading, setCommandPaletteLoading] = useState(false);
  const [commandPaletteItems, setCommandPaletteItems] = useState<CommandPaletteItem[]>([]);
  const [supervisorQuickChatOpen, setSupervisorQuickChatOpen] = useState(false);
  const [supervisorSessionId, setSupervisorSessionId] = useState<string | null>(null);
  const [supervisorQuickChatStorageReadyProjectKey, setSupervisorQuickChatStorageReadyProjectKey] = useState<string | null>(null);
  const [, setTasksMobileHeaderVersion] = useState(0);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const settingsSubnavRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavigationDialogRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const tasksMobileHeaderContextRef = useRef<TasksMobileHeaderContext | null>(null);
  const tasksMobileHeaderSignatureRef = useRef<string | null>(null);
  const shouldRestoreMobileNavigationFocusRef = useRef(false);
  const viewedSessionIdRef = useRef<string | null>(null);
  const chatSessionAgentIdRef = useRef<string | null>(null);
  const chatSessionRecoveryMissRef = useRef<{ sessionId: string; startedAt: number } | null>(null);
  const supervisorSessionRecoveryMissRef = useRef<{ sessionId: string; startedAt: number } | null>(null);
  const lastKnownChatSessionRef = useRef<SessionRecord | null>(null);
  const lastKnownChatSessionIdRef = useRef<string | null>(null);
  const lastKnownChatSessionAgentIdRef = useRef<string | null>(null);
  const lastKnownChatSessionDraftRef = useRef("");
  const activePageRef = useRef(activePage);
  const activeProjectIdRef = useRef(activeProjectId);
  const chatAgentLoadRequestIdRef = useRef(0);
  const latestForegroundChatAgentLoadRequestIdRef = useRef(0);
  const lastKnownSupervisorSessionRef = useRef<SessionRecord | null>(null);
  const lastKnownSupervisorSessionIdRef = useRef<string | null>(null);
  const lastKnownSupervisorDraftRef = useRef("");
  const sessionsRef = useRef<SessionRecord[]>([]);
  const scheduledSessionRefreshRef = useRef<number | null>(null);
  const backgroundSessionRefreshInFlightRef = useRef(false);
  const pendingSessionRecordRequestKeyRef = useRef<string | null>(null);
  const sessionListRefreshCountRef = useRef(0);
  const sessionRecordLoadCountsRef = useRef<Record<string, number>>({});
  const testPinnedSessionIdsRef = useRef<Set<string>>(new Set());
  const commandPaletteRequestIdRef = useRef(0);

  useEffect(() => {
    activePageRef.current = activePage;
  }, [activePage]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    commandPaletteRequestIdRef.current += 1;
    setCommandPaletteLoading(false);
  }, [activeProjectId]);

  useLayoutEffect(() => {
    applyOrchestraTheme(themeId);
  }, [themeId]);

  useLayoutEffect(() => {
    applyExplanatoryTooltips(explanatoryTooltipsEnabled);
  }, [explanatoryTooltipsEnabled]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => {
    storeLocalNotificationsEnabled(localNotificationsEnabled);
  }, [localNotificationsEnabled]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_NAVIGATION_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileNavigation(event.matches);
    };

    setIsMobileNavigation(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (isMobileNavigation) {
      return;
    }

    shouldRestoreMobileNavigationFocusRef.current = false;
    setIsMobileNavigationOpen(false);
  }, [isMobileNavigation]);

  useEffect(() => {
    if (!isMobileNavigation || !isMobileNavigationOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const focusTarget = mobileNavigationCloseButtonRef.current
      ?? getFocusableElements(mobileNavigationDialogRef.current)[0]
      ?? mobileNavigationDialogRef.current;
    const frameId = window.requestAnimationFrame(() => {
      focusTarget?.focus();
    });

    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frameId);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileNavigation, isMobileNavigationOpen]);

  useEffect(() => {
    if (isMobileNavigationOpen) {
      return;
    }

    if (!shouldRestoreMobileNavigationFocusRef.current) {
      return;
    }

    shouldRestoreMobileNavigationFocusRef.current = false;
    const frameId = window.requestAnimationFrame(() => {
      mobileNavigationTriggerRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isMobileNavigationOpen]);

  useEffect(() => {
    if (!isMobileNavigation || !isMobileNavigationOpen) {
      return;
    }

    const dialog = mobileNavigationDialogRef.current;
    if (!dialog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        shouldRestoreMobileNavigationFocusRef.current = true;
        setIsMobileNavigationOpen(false);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeElement === firstElement || activeElement === dialog) {
          event.preventDefault();
          lastElement?.focus();
        }
        return;
      }

      if (activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [isMobileNavigation, isMobileNavigationOpen]);

  const isDetachedWindow = isLogsWindow || isAgentTerminalWindow;
  const { projectUnreadCounts, projectTaskCommentUnreadCounts } = useProjectUnreadCounts(
    projects,
    isLogsWindow || isAgentTerminalWindow || isDetachedWindow,
  );
  const {
    referenceTasks,
    referenceAgents,
    referenceRoles,
    refresh: refreshProjectReferenceData,
  } = useProjectReferenceData(activeProjectId, isDetachedWindow);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );
  const visibleSettingsTabs = useMemo(
    () => SETTINGS_TABS.filter((tab) => {
      if (tab.id === "harness") {
        return canManageHarnessSettings;
      }
      if (tab.id === "skills") {
        return canManageSkillsSettings;
      }
      if (tab.id === "remote") {
        return canManageRemoteAccess;
      }
      return true;
    }),
    [canManageHarnessSettings, canManageRemoteAccess, canManageSkillsSettings],
  );
  const activeSettingsTab = visibleSettingsTabs.some((tab) => tab.id === settingsTab)
    ? settingsTab
    : (visibleSettingsTabs[0]?.id ?? "projects");

  useEffect(() => {
    if (settingsTab !== activeSettingsTab) {
      setSettingsTab(activeSettingsTab);
    }
  }, [activeSettingsTab, settingsTab]);

  const activeProjectUnreadCount = useMemo(
    () => (activeProjectId ? projectUnreadCounts[activeProjectId] ?? 0 : 0),
    [activeProjectId, projectUnreadCounts],
  );
  const activeProjectTaskCommentUnreadCount = useMemo(
    () => (activeProjectId ? projectTaskCommentUnreadCounts[activeProjectId] ?? 0 : 0),
    [activeProjectId, projectTaskCommentUnreadCounts],
  );

  const hasUnreadOutsideActiveProject = useMemo(
    () => projects.some((project) => project.id !== activeProjectId && (projectUnreadCounts[project.id] ?? 0) > 0),
    [activeProjectId, projectUnreadCounts, projects],
  );

  const filteredSessions = useMemo(
    () => sessions.filter((session) => isSessionVisibleInList(session) && (sessionFilter === "closed" ? isSessionClosedInList(session) : !isSessionClosedInList(session))),
    [sessionFilter, sessions],
  );

  const activeSessionCount = useMemo(
    () => sessions.filter((session) => isSessionVisibleInList(session) && !isSessionClosedInList(session)).length,
    [sessions],
  );

  const pendingSelectedSessionId = pendingSessionOpenRequest?.projectId === activeProjectId
    ? pendingSessionOpenRequest.sessionId
    : null;

  const selectedSession = useMemo(() => {
    const matchedSelectedSession = selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId) ?? null
      : null;
    if (matchedSelectedSession) {
      return matchedSelectedSession;
    }
    if (selectedSessionId && pendingSelectedSessionId === selectedSessionId) {
      return null;
    }
    return filteredSessions[0] ?? null;
  }, [filteredSessions, pendingSelectedSessionId, selectedSessionId, sessions]);

  const selectedChatAgentSnapshot = useMemo(
    () => chatAgents.find((agent) => agent.agent.id === selectedChatAgentId) ?? null,
    [chatAgents, selectedChatAgentId],
  );

  const selectedChatAgent = useMemo(
    () => selectedChatAgentSnapshot?.agent ?? null,
    [selectedChatAgentSnapshot],
  );

  const liveChatSession = useMemo(
    () => sessions.find((session) => session.id === chatSessionId) ?? null,
    [chatSessionId, sessions],
  );
  const liveSupervisorSession = useMemo(
    () => sessions.find((session) => session.id === supervisorSessionId) ?? null,
    [sessions, supervisorSessionId],
  );

  const chatSession = useMemo(() => {
    if (liveChatSession) {
      return liveChatSession;
    }

    if (chatSessionId && chatSessionAgentIdRef.current === selectedChatAgentId) {
      return lastKnownChatSessionRef.current;
    }

    return null;
  }, [chatSessionId, liveChatSession, selectedChatAgentId]);

  const viewedSession = activePage === "chat" ? chatSession : selectedSession;
  const sessionSurfaceKey = useMemo(() => {
    if (activePage === "sessions") {
      return selectedSession?.id ? `sessions:${selectedSession.id}` : null;
    }
    if (activePage === "chat") {
      return chatSession?.id ? `chat:${chatSession.id}` : null;
    }
    return null;
  }, [activePage, chatSession?.id, selectedSession?.id]);
  const viewedSessionPendingRun = viewedSession ? pendingRuns[viewedSession.id] : undefined;
  const viewedModelState = viewedSession ? modelStates[viewedSession.id] : undefined;
  const viewedSessionStats = viewedSession ? sessionStats[viewedSession.id] : undefined;
  const displayedEvents = viewedSession?.events ?? [];
  const viewedSessionDraftMessage = viewedSession ? draftMessages[viewedSession.id] ?? "" : "";
  const supervisorSession = useMemo(() => {
    if (liveSupervisorSession) {
      return liveSupervisorSession;
    }

    if (supervisorSessionId) {
      return lastKnownSupervisorSessionRef.current;
    }

    return null;
  }, [liveSupervisorSession, supervisorSessionId]);
  const supervisorSessionDraftMessage = supervisorSessionId
    ? draftMessages[supervisorSessionId] ?? lastKnownSupervisorDraftRef.current
    : "";
  const supervisorPendingRun = supervisorSessionId ? pendingRuns[supervisorSessionId] : undefined;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (liveChatSession && chatSessionAgentIdRef.current === selectedChatAgentId) {
      lastKnownChatSessionRef.current = liveChatSession;
    }
  }, [liveChatSession, selectedChatAgentId]);

  useEffect(() => {
    if (liveSupervisorSession && supervisorSessionId === liveSupervisorSession.id) {
      lastKnownSupervisorSessionRef.current = liveSupervisorSession;
    }
  }, [liveSupervisorSession, supervisorSessionId]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    const url = new URL(window.location.href);
    setSearchParam(url.searchParams, "page", activePage);
    setSearchParam(url.searchParams, "projectId", activeProjectId);
    setSearchParam(url.searchParams, "settingsTab", activePage === "settings" ? activeSettingsTab : null);
    setSearchParam(url.searchParams, "selectedTaskId", activePage === "tasks" ? selectedTaskId : null);
    setSearchParam(
      url.searchParams,
      "selectedSessionId",
      activePage === "sessions"
        ? pendingSelectedSessionId ?? selectedSessionId
        : null,
    );

    const nextSearch = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [activePage, activeProjectId, activeSettingsTab, isDetachedWindow, pendingSelectedSessionId, selectedSessionId, selectedTaskId]);

  useEffect(() => {
    if (!pendingSessionOpenRequest || pendingSessionOpenRequest.projectId !== activeProjectId) {
      return;
    }

    const targetSession = sessions.find((session) => session.id === pendingSessionOpenRequest.sessionId) ?? null;
    if (!targetSession) {
      return;
    }

    setSessionFilter(getSessionListVisibility(targetSession) === "closed" ? "closed" : "active");
    setSelectedSessionId((current) => (current === targetSession.id ? current : targetSession.id));
    setPendingSessionOpenRequest((current) => (
      current && current.sessionId === targetSession.id && current.projectId === activeProjectId
        ? null
        : current
    ));
    pendingSessionRecordRequestKeyRef.current = null;
  }, [activeProjectId, pendingSessionOpenRequest, sessions]);

  useEffect(() => {
    if (activePage !== "sessions" || pendingSelectedSessionId) {
      return;
    }

    if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }

    const fallbackSessionId = filteredSessions[0]?.id ?? null;
    setSelectedSessionId((current) => (current === fallbackSessionId ? current : fallbackSessionId));
  }, [activePage, filteredSessions, pendingSelectedSessionId, selectedSessionId, sessions]);

  useEffect(() => {
    if (isDetachedWindow || !viewedSession?.id || viewedSessionPendingRun) {
      return;
    }

    let cancelled = false;
    const sessionId = viewedSession.id;
    const timeoutId = window.setTimeout(() => {
      setLoadingStatsSessionId(sessionId);
      void orchestraClient.sessions.getStats(sessionId)
        .then((stats) => {
          if (!cancelled) {
            setSessionStats((current) => ({
              ...current,
              [sessionId]: stats,
            }));
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load session stats."));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoadingStatsSessionId((current) => (current === sessionId ? null : current));
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isDetachedWindow, viewedSession?.id, viewedSession?.updatedAt, Boolean(viewedSessionPendingRun)]);

  useEffect(() => {
    const rememberedSessionId = chatSessionId ?? lastKnownChatSessionIdRef.current;
    if (chatSessionId) {
      lastKnownChatSessionIdRef.current = chatSessionId;
    }
    if (chatSessionAgentIdRef.current) {
      lastKnownChatSessionAgentIdRef.current = chatSessionAgentIdRef.current;
    }
    if (rememberedSessionId) {
      lastKnownChatSessionDraftRef.current = draftMessages[rememberedSessionId] ?? lastKnownChatSessionDraftRef.current;
    }
  }, [chatSessionId, draftMessages]);

  useEffect(() => {
    const rememberedSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
    if (supervisorSessionId) {
      lastKnownSupervisorSessionIdRef.current = supervisorSessionId;
    }
    if (rememberedSessionId) {
      lastKnownSupervisorDraftRef.current = draftMessages[rememberedSessionId] ?? lastKnownSupervisorDraftRef.current;
    }
  }, [draftMessages, supervisorSessionId]);

  useEffect(() => {
    storeTaskOverviewState(activeProjectId, taskOverviewState);
  }, [taskOverviewState]);

  useEffect(() => {
    setTaskOverviewState(loadStoredTaskOverviewState(activeProjectId));
  }, [activeProjectId]);

  const mergeSessionRecord = useCallback((updatedSession: SessionRecord, options?: { select?: boolean }) => {
    setSessions((current) => {
      const existingSession = current.find((session) => session.id === updatedSession.id);
      const normalizedSession = normalizeSessionRecord(
        existingSession
        && updatedSession.events.length === 0
        && existingSession.events.length > 0
          ? {
              ...updatedSession,
              events: existingSession.events,
              debugInfo: updatedSession.debugInfo ?? existingSession.debugInfo,
            }
          : updatedSession,
      );
      const nextSessions = sortSessionRecords([
        normalizedSession,
        ...current.filter((session) => session.id !== normalizedSession.id),
      ]);
      return areSessionListsEqual(current, nextSessions) ? current : nextSessions;
    });

    if (options?.select) {
      setSelectedSessionId((current) => (current === updatedSession.id ? current : updatedSession.id));
    }
  }, []);

  const applySessionUpdate = useCallback((updatedSession: SessionRecord) => {
    mergeSessionRecord(updatedSession, { select: false });
  }, [mergeSessionRecord]);

  useEffect(() => {
    if (!pendingSelectedSessionId || sessions.some((session) => session.id === pendingSelectedSessionId)) {
      return;
    }

    const requestKey = `${activeProjectId ?? "default"}:${pendingSelectedSessionId}:${pendingSessionOpenRequest?.token ?? 0}`;
    if (pendingSessionRecordRequestKeyRef.current === requestKey) {
      return;
    }
    pendingSessionRecordRequestKeyRef.current = requestKey;

    let cancelled = false;
    void orchestraClient.sessions.get(pendingSelectedSessionId)
      .then((record) => {
        if (!cancelled) {
          mergeSessionRecord(record, { select: false });
        }
      })
      .catch(() => {
        if (!cancelled && pendingSessionRecordRequestKeyRef.current === requestKey) {
          pendingSessionRecordRequestKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, mergeSessionRecord, pendingSelectedSessionId, pendingSessionOpenRequest?.token, sessions]);

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

  const handleSessionScrollLockChange = useCallback((lockedToBottom: boolean) => {
    setSessionScrollState((current) => (current.lockedToBottom === lockedToBottom ? current : { lockedToBottom }));
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
    if (!hostAdminExtension || !canManageRuntimeLogs) {
      setLogs([]);
      return;
    }
    setLoadingLogs(true);
    try {
      setLogs(await hostAdminExtension.logs.list());
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleClearLogs() {
    if (!hostAdminExtension || !canManageRuntimeLogs) {
      return;
    }
    setClearingLogs(true);
    try {
      await hostAdminExtension.logs.clear();
      setLogs([]);
    } finally {
      setClearingLogs(false);
    }
  }

  async function handleOpenLogsWindow() {
    if (!shellExtension || !canOpenLogsWindow) {
      return;
    }
    await shellExtension.openLogsWindow();
  }

  async function handleExportLogsBundle() {
    if (!hostAdminExtension || !canManageRuntimeLogs) {
      return;
    }
    setExportingLogs(true);
    setLogExportMessage(null);
    setLogExportError(null);
    try {
      const bundlePath = await hostAdminExtension.logs.exportBundle(includeRelatedSessionSnapshot);
      setLogExportMessage(
        includeRelatedSessionSnapshot
          ? `Saved log bundle with related sessions and database snapshot to ${bundlePath}`
          : `Saved log bundle to ${bundlePath}`,
      );
      setLogs(await hostAdminExtension.logs.list());
    } catch (error) {
      setLogExportError(error instanceof Error ? error.message : "Unable to export log bundle.");
    } finally {
      setExportingLogs(false);
    }
  }

  async function loadBridgeDiagnostics(options?: { background?: boolean }) {
    if (!hostAdminExtension || !canManageBridgeDiagnostics) {
      setBridgeDiagnostics(null);
      return;
    }
    if (options?.background) {
      setRefreshingBridgeDiagnostics(true);
    } else {
      setLoadingBridgeDiagnostics(true);
    }
    try {
      setBridgeDiagnostics(await hostAdminExtension.bridge.getDiagnostics());
    } finally {
      if (options?.background) {
        setRefreshingBridgeDiagnostics(false);
      } else {
        setLoadingBridgeDiagnostics(false);
      }
    }
  }

  async function handleCleanupStaleBridges() {
    if (!hostAdminExtension || !canManageBridgeDiagnostics) {
      return;
    }
    setRefreshingBridgeDiagnostics(true);
    try {
      await hostAdminExtension.bridge.cleanupStaleInstances();
      if (canManageRuntimeLogs) {
        setLogs(await hostAdminExtension.logs.list());
      }
      setBridgeDiagnostics(await hostAdminExtension.bridge.getDiagnostics());
    } finally {
      setRefreshingBridgeDiagnostics(false);
    }
  }

  useEffect(() => {
    if (orchestraBootstrap.appInfo) {
      setAppInfo((current) => current ?? orchestraBootstrap.appInfo);
    }
  }, [orchestraBootstrap.appInfo]);

  async function loadAppInfo() {
    try {
      setAppInfo(await orchestraClient.app.getInfo());
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.app.info", error, "Unable to load app info."));
    }
  }

  async function loadSessionPromptSettings() {
    if (!activeProject) {
      setSessionPromptSettings(null);
      return;
    }
    setSessionPromptSettings(await getSessionPromptSettings(activeProject.slug));
  }

  async function loadPiRuntimeSettings() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      setPiRuntimeSettings(null);
      return;
    }
    try {
      setPiRuntimeSettings(await hostAdminExtension.harness.getRuntimeSettings());
    } catch (error) {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load PI runtime settings."));
    }
  }

  async function loadPiSetup() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      setPiSetupState(null);
      setLoadingPiSetup(false);
      return;
    }
    setLoadingPiSetup(true);
    try {
      setPiSetupState(await hostAdminExtension.harness.getSetupState());
    } catch (error) {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load Pi setup state."));
    } finally {
      setLoadingPiSetup(false);
    }
  }

  async function loadPiOAuthFlow() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      setPiOAuthFlowState(null);
      return;
    }
    try {
      setPiOAuthFlowState(await hostAdminExtension.harness.getOAuthFlowState());
    } catch (error) {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load Pi OAuth flow state."));
    }
  }

  async function loadPiModelsJsonState() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      setPiModelsJson('{\n  "providers": {}\n}\n');
      return;
    }
    setLoadingPiModelsJson(true);
    try {
      setPiModelsJson(await hostAdminExtension.harness.getModelsJson());
    } catch (error) {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load models.json."));
    } finally {
      setLoadingPiModelsJson(false);
    }
  }

  async function refreshPiSetupState(options?: { includeModelsJson?: boolean }) {
    await loadPiSetup();
    await loadAppInfo();
    setModelStates({});
    if (options?.includeModelsJson) {
      await loadPiModelsJsonState();
    }
  }

  async function loadSystemNotificationPermission() {
    if (!notificationsExtension || !canManageSystemNotifications) {
      setSystemNotificationEnvironment(null);
      setSystemNotificationPermission("unsupported");
      return;
    }
    try {
      const [environment, permission] = await Promise.all([
        notificationsExtension.getEnvironmentStatus(),
        notificationsExtension.getPermissionState(),
      ]);
      setSystemNotificationEnvironment(environment);
      setSystemNotificationPermission(permission);
    } catch (error) {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load system notification status."));
    }
  }

  async function handleRefreshSystemNotificationPermission() {
    if (!notificationsExtension || !canManageSystemNotifications) {
      return;
    }
    setRefreshingSystemNotificationPermission(true);
    try {
      await loadSystemNotificationPermission();
    } finally {
      setRefreshingSystemNotificationPermission(false);
    }
  }

  async function handleRequestSystemNotificationPermission() {
    if (!notificationsExtension || !canManageSystemNotifications) {
      return;
    }
    setRequestingSystemNotificationPermission(true);
    try {
      setSystemNotificationPermission(await notificationsExtension.requestPermission());
      await loadSystemNotificationPermission();
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.notifications.permission.request", error, "Unable to request system notification permission."));
    } finally {
      setRequestingSystemNotificationPermission(false);
    }
  }

  async function handleSendTestSystemNotification() {
    if (!notificationsExtension || !canManageSystemNotifications) {
      return;
    }
    setSendingTestSystemNotification(true);
    try {
      await notificationsExtension.sendTest();
      await loadSystemNotificationPermission();
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.notifications.test", error, "Unable to send the test system notification."));
    } finally {
      setSendingTestSystemNotification(false);
    }
  }

  async function handleSaveSessionPromptTemplate(template: string | null) {
    if (!activeProject) {
      return;
    }
    setSessionPromptSettings(await updateSessionPromptSettings(template, activeProject.slug));
  }

  async function handleSavePiRuntimeSettings(input: { extraExtensions: string[]; defaultCompactionWindow: string }) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    try {
      setPiRuntimeSettings(await hostAdminExtension.harness.updateRuntimeSettings(input));
      await loadAppInfo();
    } catch (error) {
      setSessionActionError(toUiErrorState(error, "Unable to save PI runtime settings."));
    }
  }

  async function handleImportLegacyPiConfiguration(input: { importAuth: boolean; importModels: boolean }) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    try {
      await hostAdminExtension.harness.importLegacyConfiguration(input);
      await Promise.all([loadAppInfo(), loadPiRuntimeSettings(), refreshPiSetupState({ includeModelsJson: true })]);
    } catch (error) {
      setSessionActionError(toUiErrorState(error, "Unable to import legacy PI configuration."));
    }
  }

  async function handleSavePiProviderApiKey(providerId: string, apiKey: string) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiSetupState(await hostAdminExtension.harness.setProviderApiKey(providerId, apiKey));
    await refreshPiSetupState({ includeModelsJson: true });
  }

  async function handleRemovePiProviderCredential(providerId: string) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiSetupState(await hostAdminExtension.harness.removeProviderCredential(providerId));
    await refreshPiSetupState({ includeModelsJson: true });
  }

  async function handleImportPiLegacyConfig(replaceExisting = false) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiSetupState(await hostAdminExtension.harness.importLegacyConfig(replaceExisting));
    await refreshPiSetupState({ includeModelsJson: true });
  }

  async function handleDismissPiLegacyImport() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiSetupState(await hostAdminExtension.harness.dismissLegacyImport());
    await refreshPiSetupState({ includeModelsJson: false });
  }

  async function handleSavePiModelsJson(content: string) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiSetupState(await hostAdminExtension.harness.saveModelsJson(content));
    await refreshPiSetupState({ includeModelsJson: true });
  }

  async function handleStartPiOAuthFlow(providerId: string, methodId?: string | null) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiOAuthFlowState(await hostAdminExtension.harness.startOAuthFlow(providerId, methodId));
  }

  async function handleSubmitPiOAuthFlowInput(value: string) {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiOAuthFlowState(await hostAdminExtension.harness.submitOAuthFlowInput(value));
  }

  async function handleCancelPiOAuthFlow() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    setPiOAuthFlowState(await hostAdminExtension.harness.cancelOAuthFlow());
  }

  async function handleDismissPiOAuthFlow() {
    if (!hostAdminExtension || !canManageHarnessSettings) {
      return;
    }
    await hostAdminExtension.harness.dismissOAuthFlow();
    setPiOAuthFlowState(null);
  }

  const loadSessions = useCallback(async (options?: { background?: boolean }) => {
    sessionListRefreshCountRef.current += 1;
    if (!options?.background) {
      setLoadingSessions(true);
    } else {
      backgroundSessionRefreshInFlightRef.current = true;
      setRefreshingSessions(true);
    }
    setSessionActionError(null);

    try {
      const listedSessions = sortSessionRecords((await retryOrchestraRead(() => orchestraClient.sessions.list(activeProjectId))).map(normalizeSessionRecord));
      const nextSessions = sortSessionRecords(
        reconcileListedSessions(sessionsRef.current, listedSessions, {
          preserveDetailedSessionIds: [
            viewedSessionIdRef.current,
            selectedSessionId,
            chatSessionId,
            supervisorSessionId,
          ].filter((value): value is string => Boolean(value)),
          preserveMissingSessionIds: [
            viewedSessionIdRef.current,
            supervisorSessionId,
            ...Array.from(testPinnedSessionIdsRef.current),
          ].filter((value): value is string => Boolean(value)),
          pendingSessionIds: Object.keys(pendingRuns),
        }),
      );

      sessionsRef.current = nextSessions;
      setSessions((current) => (areSessionListsEqual(current, nextSessions) ? current : nextSessions));
      setSelectedSessionId((current) => {
        const requestedSessionId = pendingSessionOpenRequest?.projectId === activeProjectId
          ? pendingSessionOpenRequest.sessionId
          : null;
        if (requestedSessionId) {
          return current === requestedSessionId ? current : requestedSessionId;
        }
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        if (activePage !== "sessions") {
          return current;
        }
        const fallbackSessionId = nextSessions[0]?.id ?? null;
        return current === fallbackSessionId ? current : fallbackSessionId;
      });
      const hasCurrentChatSession = Boolean(chatSessionId && nextSessions.some((session) => session.id === chatSessionId));
      setChatSessionId((current) => (current && nextSessions.some((session) => session.id === current) ? current : null));
      if (!hasCurrentChatSession) {
        chatSessionAgentIdRef.current = null;
      }
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.load", error, "Unable to load sessions."));
    } finally {
      setLoadingSessions(false);
      setRefreshingSessions(false);
      backgroundSessionRefreshInFlightRef.current = false;
    }
  }, [activePage, activeProjectId, chatSessionId, orchestraClient, pendingRuns, pendingSessionOpenRequest, selectedSessionId, supervisorSessionId]);

  const loadChatAgents = useCallback(async (options?: { background?: boolean }) => {
    const requestId = ++chatAgentLoadRequestIdRef.current;
    const requestProjectId = activeProjectId;
    const isForeground = !options?.background;

    if (isForeground) {
      latestForegroundChatAgentLoadRequestIdRef.current = requestId;
      setLoadingChatAgents(true);
    }

    try {
      const nextAgents = await listAgentOperations(false, requestProjectId);
      if (!shouldApplyChatAgentLoad(
        activePageRef.current,
        requestProjectId,
        activeProjectIdRef.current,
        requestId,
        chatAgentLoadRequestIdRef.current,
      )) {
        return;
      }
      setChatAgents(nextAgents);
      setSelectedChatAgentId((current) => {
        if (current && nextAgents.some((agent) => agent.agent.id === current)) {
          return current;
        }
        return nextAgents[0]?.agent.id ?? null;
      });
    } catch (error) {
      if (!shouldApplyChatAgentLoad(
        activePageRef.current,
        requestProjectId,
        activeProjectIdRef.current,
        requestId,
        chatAgentLoadRequestIdRef.current,
      )) {
        return;
      }
      setSessionActionError(toUiErrorState(error, "Unable to load chat agents."));
    } finally {
      if (isForeground && latestForegroundChatAgentLoadRequestIdRef.current === requestId) {
        setLoadingChatAgents(false);
      }
    }
  }, [activeProjectId]);

  async function loadSelectedSessionRuntimeDetails(sessionId: string): Promise<SessionRuntimeDetails> {
    setLoadingRuntimeDetailsSessionId(sessionId);
    try {
      return await orchestraClient.sessions.getRuntimeDetails(sessionId);
    } finally {
      setLoadingRuntimeDetailsSessionId((current) => (current === sessionId ? null : current));
    }
  }

  async function runSessionAction(action: () => Promise<SessionRecord>, options?: { select?: boolean }) {
    setIsSubmitting(true);
    setSessionActionError(null);

    try {
      const updatedSession = await action();
      mergeSessionRecord(updatedSession, { select: options?.select });
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.action", error, "Session action failed."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCreateSession() {
    await runSessionAction(async () => orchestraClient.sessions.create(undefined, activeProject?.slug ?? null), { select: true });
  }

  async function handleDeleteSession(sessionId: string) {
    setSessionActionError(null);
    setIsSubmitting(true);

    try {
      await orchestraClient.sessions.remove(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setSelectedSessionId((current) => (current === sessionId ? null : current));
      setChatSessionId((current) => (current === sessionId ? null : current));
      if (chatSessionId === sessionId) {
        chatSessionAgentIdRef.current = null;
      }
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
      setSessionStats((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      await loadSessions({ background: true });
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.dismiss", error, "Unable to dismiss session."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteClosedSessions() {
    setSessionActionError(null);
    setIsSubmitting(true);
    try {
      const closedSessions = sessions.filter((session) => isSessionClosedInList(session));
      for (const session of closedSessions) {
        await orchestraClient.sessions.remove(session.id);
      }
      const closedSessionIds = new Set(closedSessions.map((session) => session.id));
      setSessions((current) => current.filter((session) => !closedSessionIds.has(session.id)));
      setSelectedSessionId((current) => (current && closedSessionIds.has(current) ? null : current));
      setChatSessionId((current) => (current && closedSessionIds.has(current) ? null : current));
      if (chatSessionId && closedSessionIds.has(chatSessionId)) {
        chatSessionAgentIdRef.current = null;
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
      setSessionStats((current) => {
        const next = { ...current };
        for (const session of closedSessions) {
          delete next[session.id];
        }
        return next;
      });
      await loadSessions({ background: true });
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.dismiss_closed", error, "Unable to dismiss closed sessions."));
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleSessionStreamEvent = useCallback(
    (payload: SessionStreamEnvelope) => {
      const currentSession = sessionsRef.current.find((session) => session.id === payload.sessionId);
      if (!currentSession) {
        return;
      }

      const reduction = reduceSessionTranscriptEvent(
        currentSession,
        pendingRuns[payload.sessionId],
        payload,
      );
      if (!reduction) {
        return;
      }

      patchSessionRecord(payload.sessionId, () => reduction.session);
      if (reduction.pendingRun) {
        setPendingRuns((current) => ({
          ...current,
          [payload.sessionId]: reduction.pendingRun!,
        }));
      } else if (pendingRuns[payload.sessionId] && (reduction.refreshFromBackend || reduction.session.status === "failed")) {
        removePendingRun(payload.sessionId, payload.runId ?? undefined);
      }

      if (reduction.sessionActionError) {
        setSessionActionError(toUiErrorState(reduction.sessionActionError, "Session action failed."));
      }

      if (reduction.refreshFromBackend) {
        const runId = payload.runId ?? undefined;
        sessionRecordLoadCountsRef.current[payload.sessionId] = (sessionRecordLoadCountsRef.current[payload.sessionId] ?? 0) + 1;
        void orchestraClient.sessions.get(payload.sessionId)
          .then((record) => {
            applySessionUpdate(record);
            removePendingRun(payload.sessionId, runId);
          })
          .catch((error) => {
            removePendingRun(payload.sessionId, runId);
            setSessionActionError(toUiErrorState(error, "Unable to refresh session."));
          });
      }
    },
    [applySessionUpdate, patchSessionRecord, pendingRuns, removePendingRun],
  );

  useEffect(() => {
    const testWindow = window as typeof window & {
      __orchestraTestInjectSessionStream?: (payload: SessionStreamEnvelope) => void;
      __orchestraTestApplySessionRecord?: (record: SessionRecord) => void;
      __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number; recordLoadCounts: Record<string, number> };
      __orchestraTestHydrateChatAgentSession?: (payload: { agentId: string; sessionId: string; select?: boolean }) => void;
      __orchestraTestPinSessionIds?: (sessionIds: string[]) => void;
    };
    testWindow.__orchestraTestInjectSessionStream = handleSessionStreamEvent;
    testWindow.__orchestraTestApplySessionRecord = applySessionUpdate;
    testWindow.__orchestraTestSessionRefreshStats = () => ({
      listRefreshCount: sessionListRefreshCountRef.current,
      recordLoadCounts: { ...sessionRecordLoadCountsRef.current },
    });
    testWindow.__orchestraTestHydrateChatAgentSession = ({ agentId, sessionId, select = true }) => {
      let matchedAgent = false;
      const timestamp = new Date().toISOString();
      setChatAgents((current) => current.map((snapshot) => {
        if (snapshot.agent.id !== agentId) {
          return snapshot;
        }
        matchedAgent = true;
        return {
          ...snapshot,
          runtimeState: {
            ...snapshot.runtimeState,
            mainSessionId: sessionId,
            updatedAt: timestamp,
          },
        };
      }));
      if (!matchedAgent) {
        throw new Error(`Missing chat agent ${agentId}`);
      }
      if (select) {
        setSelectedChatAgentId(agentId);
      }
      setChatSessionId(sessionId);
      chatSessionAgentIdRef.current = agentId;
      lastKnownChatSessionIdRef.current = sessionId;
      lastKnownChatSessionAgentIdRef.current = agentId;
      chatSessionRecoveryMissRef.current = null;
      setSessionActionError(null);
    };
    testWindow.__orchestraTestPinSessionIds = (sessionIds) => {
      testPinnedSessionIdsRef.current = new Set(sessionIds.filter((value) => value.trim().length > 0));
    };
    return () => {
      delete testWindow.__orchestraTestInjectSessionStream;
      delete testWindow.__orchestraTestApplySessionRecord;
      delete testWindow.__orchestraTestSessionRefreshStats;
      delete testWindow.__orchestraTestHydrateChatAgentSession;
      delete testWindow.__orchestraTestPinSessionIds;
    };
  }, [applySessionUpdate, handleSessionStreamEvent]);

  useEffect(() => {
    const loadProjectCatalog = () => {
      void orchestraClient.catalog.listProjects().then((nextProjects) => {
        const storedActiveProjectId = getActiveProjectId();
        setProjects(nextProjects);
        setActiveProjectIdState((current) => {
          if (storedActiveProjectId && nextProjects.some((project) => project.id === storedActiveProjectId)) {
            return storedActiveProjectId;
          }
          if (current && nextProjects.some((project) => project.id === current)) {
            return current;
          }
          const fallbackProject = nextProjects[0] ?? null;
          if (fallbackProject) {
            setActiveProjectId(fallbackProject.id, fallbackProject.slug);
          }
          return fallbackProject?.id ?? null;
        });
      });
    };

    void loadAppInfo();
    void loadPiRuntimeSettings();
    void loadPiSetup();
    void loadPiOAuthFlow();
    void loadSystemNotificationPermission();
    if (shellExtension) {
      void shellExtension.getWindowState().then((state) => {
        setIsLogsWindow(state.isLogsWindow);
        setIsAgentTerminalWindow(state.isAgentTerminalWindow);
        setAgentTerminalSessionId(state.agentTerminalSessionId);
      });
    }
    loadProjectCatalog();
    const onProjectsChanged = () => loadProjectCatalog();
    const onPiSetupChanged = () => {
      void (async () => {
        await refreshPiSetupState({ includeModelsJson: true });
        await loadPiOAuthFlow();
      })();
    };
    const onPiOAuthFlowChanged = (event: Event) => {
      if (event instanceof CustomEvent) {
        setPiOAuthFlowState(event.detail as PiOAuthFlowState | null);
      }
    };
    window.addEventListener("orchestra:projects-changed", onProjectsChanged);
    window.addEventListener("orchestra:pi-setup-change", onPiSetupChanged);
    window.addEventListener("orchestra:pi-oauth-flow-change", onPiOAuthFlowChanged);
    return () => {
      window.removeEventListener("orchestra:projects-changed", onProjectsChanged);
      window.removeEventListener("orchestra:pi-setup-change", onPiSetupChanged);
      window.removeEventListener("orchestra:pi-oauth-flow-change", onPiOAuthFlowChanged);
    };
  }, [hostAdminExtension, shellExtension]);

  useEffect(() => {
    if (activeProjectId) {
      setActiveProjectId(activeProjectId, activeProject?.slug ?? null);
    } else {
      setActiveProjectId(null, null);
    }
    sessionsRef.current = [];
    pendingSessionRecordRequestKeyRef.current = null;
    setSessions([]);
    setSelectedSessionId(pendingSessionOpenRequest?.projectId === activeProjectId ? pendingSessionOpenRequest.sessionId : null);
    setChatSessionId(null);
    chatSessionAgentIdRef.current = null;
    chatSessionRecoveryMissRef.current = null;
    lastKnownChatSessionIdRef.current = null;
    lastKnownChatSessionAgentIdRef.current = null;
    lastKnownChatSessionDraftRef.current = "";
  }, [activeProject?.slug, activeProjectId, pendingSessionOpenRequest]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    void refreshProjectReferenceData().catch((error) => {
      setSessionActionError((current) => current ?? toUiErrorState(error, "Unable to load project references."));
    });
  }, [activePage, activeSettingsTab, isDetachedWindow, refreshProjectReferenceData]);

  useNotificationController({
    disabled: isDetachedWindow || isLogsWindow || isAgentTerminalWindow,
    enabled: localNotificationsEnabled,
    notifications: notificationsExtension,
  });

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
    const resolvedProjectId = activeProjectId ?? getActiveProjectId();
    const projectKey = resolvedProjectId ?? "default";
    const stored = window.localStorage.getItem(supervisorQuickChatStorageKey(resolvedProjectId));
    if (!stored) {
      lastKnownSupervisorSessionRef.current = null;
      lastKnownSupervisorSessionIdRef.current = null;
      lastKnownSupervisorDraftRef.current = "";
      supervisorSessionRecoveryMissRef.current = null;
      setSupervisorQuickChatStorageReadyProjectKey(projectKey);
      setSupervisorSessionId(null);
      return;
    }

    try {
      const parsed = JSON.parse(stored) as { sessionId?: string; draft?: string };
      const restoredSessionId = parsed.sessionId ?? null;
      const restoredDraft = typeof parsed.draft === "string" ? parsed.draft : "";
      lastKnownSupervisorSessionRef.current = null;
      lastKnownSupervisorSessionIdRef.current = restoredSessionId;
      lastKnownSupervisorDraftRef.current = restoredDraft;
      supervisorSessionRecoveryMissRef.current = null;
      setSupervisorQuickChatStorageReadyProjectKey(projectKey);
      setSupervisorSessionId(restoredSessionId);
      if (restoredSessionId && restoredDraft) {
        setDraftMessages((current) => ({
          ...current,
          [restoredSessionId]: restoredDraft,
        }));
      }
    } catch {
      lastKnownSupervisorSessionRef.current = null;
      lastKnownSupervisorSessionIdRef.current = null;
      lastKnownSupervisorDraftRef.current = "";
      supervisorSessionRecoveryMissRef.current = null;
      setSupervisorQuickChatStorageReadyProjectKey(projectKey);
      setSupervisorSessionId(null);
    }
  }, [activeProjectId]);

  useEffect(() => {
    const resolvedProjectId = activeProjectId ?? getActiveProjectId();
    if (!resolvedProjectId) {
      return;
    }

    const projectKey = resolvedProjectId ?? "default";
    if (supervisorQuickChatStorageReadyProjectKey !== projectKey) {
      return;
    }

    const draft = supervisorSessionId
      ? draftMessages[supervisorSessionId] ?? lastKnownSupervisorDraftRef.current
      : "";
    window.localStorage.setItem(
      supervisorQuickChatStorageKey(resolvedProjectId),
      JSON.stringify({ sessionId: supervisorSessionId, draft }),
    );
  }, [activeProjectId, draftMessages, supervisorQuickChatStorageReadyProjectKey, supervisorSessionId]);

  const requestBackgroundSessionRefresh = useCallback(() => {
    if (scheduledSessionRefreshRef.current !== null || backgroundSessionRefreshInFlightRef.current) {
      return;
    }
    scheduledSessionRefreshRef.current = window.setTimeout(() => {
      scheduledSessionRefreshRef.current = null;
      backgroundSessionRefreshInFlightRef.current = true;
      void loadSessions({ background: true });
    }, 200);
  }, [loadSessions]);

  useSessionEventRefresh({
    disabled: isDetachedWindow,
    hasSession: (sessionId) => sessionsRef.current.some((session) => session.id === sessionId),
    onSessionStream: (_sessionId, payload) => {
      handleSessionStreamEvent(payload as SessionStreamEnvelope);
    },
    requestRefresh: requestBackgroundSessionRefresh,
  });

  useEffect(() => {
    if (scheduledSessionRefreshRef.current === null) {
      return;
    }

    return () => {
      if (scheduledSessionRefreshRef.current !== null) {
        window.clearTimeout(scheduledSessionRefreshRef.current);
        scheduledSessionRefreshRef.current = null;
      }
    };
  }, [requestBackgroundSessionRefresh]);

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

  const refreshSessionsInBackground = useCallback(() => {
    void loadSessions({ background: true });
  }, [loadSessions]);

  useSessionPollingRefresh({
    disabled: isDetachedWindow,
    active: activePage === "sessions" || activePage === "chat" || supervisorQuickChatOpen,
    refresh: refreshSessionsInBackground,
  });

  useEffect(() => {
    if (isDetachedWindow || activePage !== "chat") {
      return;
    }

    void loadChatAgents();
  }, [activePage, activeProjectId, isDetachedWindow, loadChatAgents]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    return listenToAgentCatalogChanges(() => {
      if (activePageRef.current !== "chat") {
        return;
      }

      void loadChatAgents({ background: true });
    });
  }, [isDetachedWindow, loadChatAgents]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "chat" || !selectedChatAgentId) {
      return;
    }

    const cachedMainSessionId = selectedChatAgentSnapshot?.runtimeState.mainSessionId ?? null;
    const cachedMainSession = cachedMainSessionId
      ? sessions.find((session) => session.id === cachedMainSessionId) ?? null
      : null;

    if (!chatSessionId && cachedMainSession) {
      setChatSessionId(cachedMainSession.id);
      chatSessionAgentIdRef.current = selectedChatAgentId;
      lastKnownChatSessionIdRef.current = cachedMainSession.id;
      lastKnownChatSessionAgentIdRef.current = selectedChatAgentId;
      chatSessionRecoveryMissRef.current = null;
      return;
    }

    const hasLiveChatSessionInState = Boolean(
      chatSessionId
      && chatSessionAgentIdRef.current === selectedChatAgentId
      && liveChatSession?.id === chatSessionId,
    );
    if (hasLiveChatSessionInState) {
      chatSessionRecoveryMissRef.current = null;
      return;
    }

    const missingChatSessionId = chatSessionId ?? cachedMainSessionId ?? lastKnownChatSessionIdRef.current;
    const missingChatSessionAgentId = chatSessionAgentIdRef.current ?? lastKnownChatSessionAgentIdRef.current;
    const missingChatDraft = missingChatSessionId
      ? draftMessages[missingChatSessionId] ?? lastKnownChatSessionDraftRef.current
      : lastKnownChatSessionDraftRef.current;
    let cancelled = false;
    setLoadingChatSessionAgentId(selectedChatAgentId);
    setSessionActionError(null);

    const recoverChatSession = async () => {
      if (missingChatSessionId && missingChatSessionAgentId === selectedChatAgentId) {
        try {
          return await orchestraClient.sessions.get(missingChatSessionId);
        } catch {
          if (lastKnownChatSessionRef.current?.id === missingChatSessionId) {
            const now = Date.now();
            const existingMiss = chatSessionRecoveryMissRef.current;
            if (!existingMiss || existingMiss.sessionId !== missingChatSessionId) {
              chatSessionRecoveryMissRef.current = { sessionId: missingChatSessionId, startedAt: now };
              return null;
            }
            if (now - existingMiss.startedAt < CHAT_SESSION_RECOVERY_GRACE_MS) {
              return null;
            }
          }
        }
      }

      return ensureAgentSession(selectedChatAgentId, activeProject?.id ?? null);
    };

    void recoverChatSession()
      .then((session) => {
        if (cancelled || !session) {
          return;
        }
        chatSessionRecoveryMissRef.current = null;
        mergeSessionRecord(session, { select: false });
        setChatSessionId(session.id);
        chatSessionAgentIdRef.current = selectedChatAgentId;
        lastKnownChatSessionIdRef.current = session.id;
        lastKnownChatSessionAgentIdRef.current = selectedChatAgentId;
        if (missingChatDraft.trim()) {
          setDraftMessages((current) => ({
            ...current,
            [session.id]: current[session.id]?.trim() ? current[session.id] : missingChatDraft,
          }));
        }
        lastKnownChatSessionDraftRef.current = missingChatDraft;
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionActionError(toUiErrorState(error, "Unable to open chat session."));
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
  }, [activePage, activeProject?.id, chatSessionId, draftMessages, isDetachedWindow, liveChatSession?.id, mergeSessionRecord, selectedChatAgentId, selectedChatAgentSnapshot?.runtimeState.mainSessionId, sessions]);

  useEffect(() => {
    if (isDetachedWindow || (!supervisorQuickChatOpen && !supervisorSessionId)) {
      return;
    }

    const currentSupervisorSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
    const hasLiveSupervisorSession = Boolean(
      currentSupervisorSessionId
      && liveSupervisorSession?.id === currentSupervisorSessionId,
    );
    if (hasLiveSupervisorSession) {
      supervisorSessionRecoveryMissRef.current = null;
      return;
    }

    const missingSupervisorSessionId = currentSupervisorSessionId;
    const missingSupervisorDraft = missingSupervisorSessionId
      ? draftMessages[missingSupervisorSessionId] ?? lastKnownSupervisorDraftRef.current
      : lastKnownSupervisorDraftRef.current;
    let cancelled = false;
    setSessionActionError(null);

    const recoverSupervisorSession = async () => {
      if (missingSupervisorSessionId) {
        try {
          return await orchestraClient.sessions.get(missingSupervisorSessionId);
        } catch {
          if (lastKnownSupervisorSessionRef.current?.id === missingSupervisorSessionId) {
            const now = Date.now();
            const existingMiss = supervisorSessionRecoveryMissRef.current;
            if (!existingMiss || existingMiss.sessionId !== missingSupervisorSessionId) {
              supervisorSessionRecoveryMissRef.current = { sessionId: missingSupervisorSessionId, startedAt: now };
              return null;
            }
            if (now - existingMiss.startedAt < CHAT_SESSION_RECOVERY_GRACE_MS) {
              return null;
            }
          }
        }
      }

      return ensureAgentSession(SUPERVISOR_AGENT_ID, activeProject?.id ?? getActiveProjectId() ?? null);
    };

    void recoverSupervisorSession()
      .then((session) => {
        if (cancelled || !session) {
          return;
        }
        supervisorSessionRecoveryMissRef.current = null;
        mergeSessionRecord(session, { select: false });
        setSupervisorSessionId((current) => (current === session.id ? current : session.id));
        lastKnownSupervisorSessionIdRef.current = session.id;
        if (missingSupervisorDraft.trim()) {
          setDraftMessages((current) => ({
            ...current,
            [session.id]: current[session.id]?.trim() ? current[session.id] : missingSupervisorDraft,
          }));
        }
        lastKnownSupervisorDraftRef.current = missingSupervisorDraft;
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionActionError(toUiErrorState(error, "Unable to open supervisor quick chat."));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, draftMessages, isDetachedWindow, liveSupervisorSession?.id, mergeSessionRecord, supervisorQuickChatOpen, supervisorSessionId]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "settings" || activeSettingsTab !== "harness" || !canManageHarnessSettings) {
      return;
    }

    void loadPiSetup();
    void loadPiModelsJsonState();
  }, [activePage, activeSettingsTab, canManageHarnessSettings, isDetachedWindow]);

  useLayoutEffect(() => {
    if (isDetachedWindow || activePage !== "settings" || isSidebarCollapsed) {
      return;
    }

    settingsSubnavRef.current
      ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePage, activeSettingsTab, isDetachedWindow, isSidebarCollapsed]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "settings" || activeSettingsTab !== "general") {
      return;
    }

    if (canManageRuntimeLogs) {
      void loadLogs();
    }
    if (canManageBridgeDiagnostics) {
      void loadBridgeDiagnostics();
    }
    if (canManageSystemNotifications) {
      void loadSystemNotificationPermission();
    }
    if (!canManageRuntimeLogs && !canManageBridgeDiagnostics) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (canManageRuntimeLogs) {
        void loadLogs();
      }
      if (canManageBridgeDiagnostics) {
        void loadBridgeDiagnostics({ background: true });
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [activePage, activeSettingsTab, canManageBridgeDiagnostics, canManageRuntimeLogs, canManageSystemNotifications, isDetachedWindow, activeProject?.slug]);

  useEffect(() => {
    if (isDetachedWindow || activePage !== "settings" || activeSettingsTab !== "prompting") {
      return;
    }

    void loadSessionPromptSettings();
  }, [activePage, activeSettingsTab, isDetachedWindow, activeProject?.slug]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    const sessionSurfaceActive = activePage === "sessions" || activePage === "chat";
    const previousViewedSessionId = viewedSessionIdRef.current;
    const nextViewedSessionId = sessionSurfaceActive ? viewedSession?.id ?? null : null;

    viewedSessionIdRef.current = nextViewedSessionId;

    if (
      previousViewedSessionId
      && previousViewedSessionId !== nextViewedSessionId
      && (!sessionSurfaceActive || Boolean(viewedSession?.id))
    ) {
      void orchestraClient.sessions.unsubscribe(previousViewedSessionId)
        .then((record) => {
          mergeSessionRecord(record, { select: false });
        })
        .catch(() => {
          // Ignore auto-unsubscribe failures; explicit actions will surface errors.
        });
    }

    if (!sessionSurfaceActive || !viewedSession) {
      return;
    }

    let cancelled = false;

    if (!viewedSession.subscribed && !viewedSession.terminalAttached) {
      void orchestraClient.sessions.subscribe(viewedSession.id)
        .then((record) => {
          if (!cancelled) {
            applySessionUpdate(record);
          }
        })
        .catch(async (error) => {
          if (!cancelled) {
            setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.subscribe", error, "Unable to subscribe to session."));
          }
        });

      return () => {
        cancelled = true;
      };
    }

    setLoadingModelSessionId(viewedSession.id);

    void orchestraClient.sessions.getModelState(viewedSession.id)
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
          setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.model_state.load", error, "Unable to load session model."));
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
    if (isDetachedWindow || (activePage !== "sessions" && activePage !== "chat") || !viewedSession?.id) {
      return;
    }

    let cancelled = false;

    sessionRecordLoadCountsRef.current[viewedSession.id] = (sessionRecordLoadCountsRef.current[viewedSession.id] ?? 0) + 1;
    void orchestraClient.sessions.get(viewedSession.id)
      .then((record) => {
        if (!cancelled) {
          mergeSessionRecord(record, { select: false });
        }
      })
      .catch(async (error) => {
        if (!cancelled) {
          setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.record.load", error, "Unable to load session."));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePage, isDetachedWindow, mergeSessionRecord, viewedSession?.id]);

  useEffect(() => {
    if (
      isDetachedWindow
      || (activePage !== "sessions" && activePage !== "chat")
      || !viewedSession?.id
      || viewedSession.status !== "active"
      || viewedSession.subscribed
    ) {
      return;
    }

    let cancelled = false;

    const refreshSelectedSession = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      sessionRecordLoadCountsRef.current[viewedSession.id] = (sessionRecordLoadCountsRef.current[viewedSession.id] ?? 0) + 1;
      void orchestraClient.sessions.get(viewedSession.id)
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

  useLayoutEffect(() => {
    if (isDetachedWindow || !sessionSurfaceKey) {
      return;
    }

    setSessionScrollState((current) => (current.lockedToBottom ? current : { lockedToBottom: true }));

    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    // Treat every session/chat surface entry as a fresh follow-latest view before paint so
    // the passive DOM sync effect cannot preserve a stale top-of-transcript position.
    node.scrollTop = node.scrollHeight;
  }, [isDetachedWindow, sessionSurfaceKey]);

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }

    const node = transcriptRef.current;
    if (!node || !sessionScrollState.lockedToBottom) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [displayedEvents, isDetachedWindow, sessionSurfaceKey, sessionScrollState.lockedToBottom]);

  useEffect(() => {
    if (isDetachedWindow || (activePage !== "sessions" && activePage !== "chat")) {
      return;
    }

    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    const syncScrollLockState = () => {
      handleSessionScrollLockChange(isScrolledToBottom(node));
    };

    syncScrollLockState();
    window.addEventListener("resize", syncScrollLockState);
    return () => window.removeEventListener("resize", syncScrollLockState);
  }, [activePage, displayedEvents.length, handleSessionScrollLockChange, isDetachedWindow, sessionSurfaceKey]);

  const activeTheme = useMemo(() => getOrchestraThemeDefinition(themeId), [themeId]);
  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);
  const mobileNavItems = useMemo(() => NAV_ITEMS, []);
  const navBadgeByPage: Partial<Record<PrimaryPage, string>> = useMemo(() => ({
    tasks: formatNavigationBadgeCount(activeProjectTaskCommentUnreadCount),
    inbox: formatNavigationBadgeCount(activeProjectUnreadCount),
    sessions: formatNavigationBadgeCount(activeSessionCount),
  }), [activeProjectTaskCommentUnreadCount, activeProjectUnreadCount, activeSessionCount]);
  const activeTasksMobileHeaderContext = activePage === "tasks" ? tasksMobileHeaderContextRef.current : null;

  const handleThemeChange = useCallback((nextThemeId: OrchestraThemeId) => {
    setThemeId(nextThemeId);
    storeOrchestraTheme(nextThemeId);
  }, []);
  const handleExplanatoryTooltipsToggle = useCallback((nextEnabled: boolean) => {
    setExplanatoryTooltipsEnabled(nextEnabled);
    storeExplanatoryTooltips(nextEnabled);
  }, []);
  const closeMobileNavigation = useCallback((options?: { restoreFocus?: boolean }) => {
    shouldRestoreMobileNavigationFocusRef.current = options?.restoreFocus ?? true;
    setIsMobileNavigationOpen(false);
  }, []);
  const handleTasksMobileHeaderContextChange = useCallback((context: TasksMobileHeaderContext | null) => {
    tasksMobileHeaderContextRef.current = context;
    const nextSignature = context?.signature ?? null;
    if (tasksMobileHeaderSignatureRef.current === nextSignature) {
      return;
    }
    tasksMobileHeaderSignatureRef.current = nextSignature;
    setTasksMobileHeaderVersion((current) => current + 1);
  }, []);
  const selectedSessionPendingRun = selectedSession ? pendingRuns[selectedSession.id] : undefined;
  const selectedModelState = selectedSession ? modelStates[selectedSession.id] : undefined;
  const selectedSessionDraftMessage = selectedSession ? draftMessages[selectedSession.id] ?? "" : "";
  const chatSessionPendingRun = chatSession ? pendingRuns[chatSession.id] : undefined;
  const chatModelState = chatSession ? modelStates[chatSession.id] : undefined;
  const chatSessionDraftMessage = chatSession ? draftMessages[chatSession.id] ?? "" : "";
  const selectedSessionDisplayStatus: SessionStatus = selectedSessionPendingRun ? "streaming" : selectedSession?.status ?? "idle";
  const chatSessionDisplayStatus: SessionStatus = chatSessionPendingRun ? "streaming" : chatSession?.status ?? "idle";

  const handleModelChange = useCallback(async (sessionId: string, value: string) => {
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
      const state = await orchestraClient.sessions.setModel(session.id, provider, modelId);
      setModelStates((current) => ({
        ...current,
        [state.sessionId]: state,
      }));
    } catch (error) {
      setSessionActionError(toUiErrorState(error, "Unable to change models."));
    } finally {
      setChangingModelSessionId((current) => (current === session.id ? null : current));
    }
  }, [sessions]);

  function navigateToTask(taskId: string, projectId?: string | null) {
    const targetProjectId = projectId ?? activeProjectId;
    if (targetProjectId && targetProjectId !== activeProjectId) {
      setActiveProjectIdState(targetProjectId);
    }
    setActivePage("tasks");
    setSelectedTaskId(taskId);
    setTasksOpenRequest((current) => ({ taskId, token: (current?.token ?? 0) + 1, projectId: targetProjectId }));
  }

  function navigateToSession(sessionId: string, projectId?: string | null) {
    const targetProjectId = projectId ?? activeProjectId;
    const session = targetProjectId === activeProjectId
      ? sessions.find((entry) => entry.id === sessionId) ?? null
      : null;
    if (targetProjectId && targetProjectId !== activeProjectId) {
      setActiveProjectIdState(targetProjectId);
    }
    setActivePage("sessions");
    setSessionFilter(session && getSessionListVisibility(session) === "closed" ? "closed" : "active");
    setSelectedSessionId(sessionId);
    setPendingSessionOpenRequest((current) => ({ sessionId, token: (current?.token ?? 0) + 1, projectId: targetProjectId }));
  }

  function navigateToTasksOverview(tag?: string) {
    setActivePage("tasks");
    setSelectedTaskId(null);
    if (tag) {
      setTaskOverviewState((current) => buildTaskOverviewStateForTagNavigation(current, tag));
    }
    setTasksOverviewToken((current) => current + 1);
  }

  function navigateToHarnessSettings() {
    setActivePage("settings");
    setSettingsTab(canManageHarnessSettings ? "harness" : "general");
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

  function navigateToSkill(skillId: string) {
    setActivePage("settings");
    setSettingsTab("skills");
    setSkillsSelectionRequest((current) => ({ skillId, token: (current?.token ?? 0) + 1 }));
  }

  function handleProjectSelection(projectId: string) {
    setActiveProjectIdState(projectId);
    closeMobileNavigation({ restoreFocus: false });
  }

  function handlePrimaryNavigationSelection(page: PrimaryPage) {
    if (page === "tasks") {
      navigateToTasksOverview();
    } else {
      setActivePage(page);
    }

    if (isMobileNavigation && page === "settings") {
      shouldRestoreMobileNavigationFocusRef.current = false;
      setIsMobileNavigationOpen(true);
      return;
    }

    closeMobileNavigation({ restoreFocus: false });
  }

  function handleSettingsTabSelection(tabId: SettingsTab) {
    setActivePage("settings");
    setSettingsTab(tabId);
    closeMobileNavigation({ restoreFocus: false });
  }

  function handleChatAgentSelection(agentId: string) {
    navigateToChatAgent(agentId);
    closeMobileNavigation({ restoreFocus: false });
  }

  async function handleOpenAgentSession(agentId: string, options?: { openQuickChat?: boolean }) {
    setSessionActionError(null);
    try {
      const session = await ensureAgentSession(agentId, activeProject?.id ?? getActiveProjectId() ?? null);
      mergeSessionRecord(session, { select: false });
      if (options?.openQuickChat) {
        setSupervisorSessionId(session.id);
        setSupervisorQuickChatOpen(true);
      } else {
        setActivePage("sessions");
        setPendingSessionOpenRequest(null);
        setSelectedSessionId(session.id);
      }
    } catch (error) {
      setSessionActionError(toUiErrorState(error, "Unable to open agent session."));
    }
  }

  async function handleOpenAgentSessionTerminal(agentId: string) {
    if (!shellExtension || !canUseAgentTerminal) {
      return;
    }
    setSessionActionError(null);
    try {
      const session = await shellExtension.agentTerminal.openSession(agentId, activeProject?.id ?? getActiveProjectId() ?? null);
      mergeSessionRecord(session, { select: false });
      setActivePage("sessions");
      setPendingSessionOpenRequest(null);
      setSelectedSessionId(session.id);
    } catch (error) {
      setSessionActionError(toUiErrorState(error, "Unable to open agent terminal window."));
    }
  }

  async function refreshCommandPaletteItems() {
    const requestId = commandPaletteRequestIdRef.current + 1;
    commandPaletteRequestIdRef.current = requestId;
    const testWindow = window as typeof window & {
      __orchestraTestCommandPalette?: {
        hangSources?: Array<"sessions" | "tasks" | "agents" | "roles" | "workflows" | "projects">;
        delayMsBySource?: Partial<Record<"sessions" | "tasks" | "agents" | "roles" | "workflows" | "projects", number>>;
        sourceTimeoutMs?: number;
      };
    };
    const testConfig = testWindow.__orchestraTestCommandPalette;
    const sourceTimeoutMs = Math.max(50, testConfig?.sourceTimeoutMs ?? COMMAND_PALETTE_SOURCE_TIMEOUT_MS);
    const commandPaletteState: {
      sessions: SessionRecord[];
      tasks: TaskSummary[];
      agents: AgentOperationsSnapshot[];
      roles: RoleOperationsSnapshot[];
      workflows: WorkflowSummary[];
      projects: ProjectSummary[];
    } = {
      sessions,
      tasks: activeProjectId ? referenceTasks.filter((task) => task.projectId === activeProjectId) : referenceTasks,
      agents: activeProjectId ? chatAgents.filter((agent) => agent.runtimeState.projectId === activeProjectId) : chatAgents,
      roles: [],
      workflows: [],
      projects,
    };

    const applyCommandPaletteItems = () => {
      if (commandPaletteRequestIdRef.current !== requestId) {
        return;
      }
      setCommandPaletteItems(
        buildCommandPaletteItems({
          sessions: commandPaletteState.sessions,
          tasks: commandPaletteState.tasks,
          agents: commandPaletteState.agents,
          roles: commandPaletteState.roles,
          workflows: commandPaletteState.workflows,
          projects: commandPaletteState.projects,
          activeProjectId,
          supportsLogsWindow: canOpenLogsWindow,
          supportsHarnessSettings: canManageHarnessSettings,
          supportsSkillsSettings: canManageSkillsSettings,
          supportsAgentTerminal: canUseAgentTerminal,
          supportsRemoteAccess: canManageRemoteAccess,
        }),
      );
    };

    async function wrapCommandPaletteSource<T>(
      sourceName: "sessions" | "tasks" | "agents" | "roles" | "workflows" | "projects",
      load: () => Promise<T>,
    ) {
      const delayMs = testConfig?.delayMsBySource?.[sourceName] ?? 0;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, delayMs);
        });
      }
      if (testConfig?.hangSources?.includes(sourceName)) {
        return await new Promise<T>(() => undefined);
      }
      return load();
    }

    const loadSessions = () => retryOrchestraRead(async () => sortSessionRecords((await orchestraClient.sessions.list(activeProjectId)).map(normalizeSessionRecord)));
    const trackedSources: Array<{
      name: "sessions" | "tasks" | "agents" | "roles" | "workflows" | "projects";
      load: () => Promise<unknown>;
      apply: (value: unknown) => void;
    }> = [
      {
        name: "sessions",
        load: () => wrapCommandPaletteSource("sessions", loadSessions),
        apply: (value) => {
          const nextSessions = value as SessionRecord[];
          commandPaletteState.sessions = nextSessions;
          setSessions((current) => (areSessionListsEqual(current, nextSessions) ? current : nextSessions));
        },
      },
      {
        name: "tasks",
        load: () => wrapCommandPaletteSource("tasks", () => retryOrchestraRead(() => orchestraClient.tasks.list({ includeArchived: false, projectId: activeProjectId }))),
        apply: (value) => {
          commandPaletteState.tasks = value as TaskSummary[];
        },
      },
      {
        name: "agents",
        load: () => wrapCommandPaletteSource("agents", () => listAgentOperations(false, activeProjectId)),
        apply: (value) => {
          commandPaletteState.agents = value as AgentOperationsSnapshot[];
        },
      },
      {
        name: "roles",
        load: () => wrapCommandPaletteSource("roles", () => listRoleOperations(false)),
        apply: (value) => {
          commandPaletteState.roles = value as RoleOperationsSnapshot[];
        },
      },
      {
        name: "workflows",
        load: () => wrapCommandPaletteSource("workflows", () => retryOrchestraRead(() => orchestraClient.catalog.listWorkflows(false))),
        apply: (value) => {
          commandPaletteState.workflows = value as WorkflowSummary[];
        },
      },
      {
        name: "projects",
        load: () => wrapCommandPaletteSource("projects", () => retryOrchestraRead(() => orchestraClient.catalog.listProjects())),
        apply: (value) => {
          const nextProjects = value as ProjectSummary[];
          commandPaletteState.projects = nextProjects;
          setProjects(nextProjects);
        },
      },
    ];

    setCommandPaletteLoading(true);
    applyCommandPaletteItems();

    const sourceErrors: unknown[] = [];
    await Promise.all(trackedSources.map((source) => new Promise<void>((resolve) => {
      let finished = false;
      const timeoutHandle = window.setTimeout(() => {
        if (finished) {
          return;
        }
        finished = true;
        console.warn(`[command-palette] ${source.name} is still loading after ${sourceTimeoutMs}ms; keeping partial results visible.`);
        resolve();
      }, sourceTimeoutMs);

      source.load()
        .then((value) => {
          if (commandPaletteRequestIdRef.current !== requestId) {
            return;
          }
          source.apply(value);
          applyCommandPaletteItems();
        })
        .catch((error) => {
          sourceErrors.push(error);
          console.warn(`[command-palette] Failed to load ${source.name}.`, error);
        })
        .finally(() => {
          window.clearTimeout(timeoutHandle);
          if (finished) {
            return;
          }
          finished = true;
          resolve();
        });
    })));

    if (commandPaletteRequestIdRef.current !== requestId) {
      return;
    }
    if (sourceErrors.length === trackedSources.length) {
      setSessionActionError(toUiErrorState(sourceErrors[0], "Unable to load command palette items."));
    }
    setCommandPaletteLoading(false);
  }

  function handleOpenCommandPalette() {
    setCommandPaletteOpen(true);
    void refreshCommandPaletteItems();
  }

  async function handleOpenSupervisorQuickChat() {
    setCommandPaletteOpen(false);
    setSessionActionError(null);

    let restoredSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
    if (!restoredSessionId) {
      const stored = window.localStorage.getItem(supervisorQuickChatStorageKey(activeProjectId ?? getActiveProjectId()));
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { sessionId?: string; draft?: string };
          restoredSessionId = parsed.sessionId ?? null;
          const restoredDraft = typeof parsed.draft === "string" ? parsed.draft : "";
          lastKnownSupervisorSessionIdRef.current = restoredSessionId;
          lastKnownSupervisorDraftRef.current = restoredDraft;
          if (restoredSessionId) {
            setSupervisorSessionId(restoredSessionId);
            if (restoredDraft) {
              setDraftMessages((current) => ({
                ...current,
                [restoredSessionId as string]: restoredDraft,
              }));
            }
          }
        } catch {
          restoredSessionId = null;
        }
      }
    }

    if (!restoredSessionId) {
      await handleOpenAgentSession(SUPERVISOR_AGENT_ID, { openQuickChat: true });
      return;
    }
    setSupervisorQuickChatOpen(true);
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
        navigateToSession(item.action.sessionId);
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
      case "switch-project":
        setActiveProjectIdState(item.action.projectId);
        return;
      case "create-task":
        setActivePage("tasks");
        setTasksCreateProjectId(activeProjectId ?? projects[0]?.id ?? null);
        setTasksCreateToken((current) => current + 1);
        return;
      case "create-session":
        setActivePage("sessions");
        await handleCreateSession();
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

  const handleStopSession = useCallback((sessionId: string) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const timestamp = nowIso();
    setSessionActionError(null);

    void orchestraClient.sessions.stopRuntime(sessionId)
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
        setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.stop", error, "Unable to stop session runtime."));
      });
  }, [mergeSessionRecord, removePendingRun, sessions]);

  const queueSessionMessage = useCallback((sessionId: string, message: string, options?: { clearDraft?: boolean }) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    const clearDraft = options?.clearDraft ?? false;
    const previousDraft = draftMessages[sessionId] ?? "";
    const runId = createClientId("run");
    const timestamp = nowIso();
    const pendingRun = createPendingUserRun(runId, trimmedMessage, timestamp);

    setSessionActionError(null);
    if (clearDraft) {
      updateDraftMessage(sessionId, "");
    }
    setPendingRuns((current) => ({
      ...current,
      [sessionId]: pendingRun,
    }));
    patchSessionRecord(sessionId, (record) => applyPendingRunToSession(record, pendingRun));

    void orchestraClient.sessions.sendMessage(sessionId, trimmedMessage, runId).catch(async (error) => {
      patchSessionRecord(sessionId, (record) => ({
        ...record,
        status: "failed",
        events: record.events.filter((event) => event.runId !== runId),
      }));
      removePendingRun(sessionId, runId);
      if (clearDraft) {
        updateDraftMessage(sessionId, previousDraft);
      }
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.message.queue", error, "Unable to queue message."));
    });
  }, [draftMessages, patchSessionRecord, removePendingRun, sessions, updateDraftMessage]);

  const handleSendMessage = useCallback((sessionId: string) => {
    const trimmedMessage = (draftMessages[sessionId] ?? "").trim();
    if (!trimmedMessage) {
      return;
    }

    queueSessionMessage(sessionId, trimmedMessage, { clearDraft: true });
  }, [draftMessages, queueSessionMessage]);

  async function handleCreateFreshSession(sessionId?: string | null, options?: { chatAgentId?: string | null }) {
    setIsSubmitting(true);
    setSessionActionError(null);

    try {
      const nextSession = sessionId
        ? await orchestraClient.sessions.createContextual(sessionId, activeProject?.slug ?? null)
        : await orchestraClient.sessions.create(undefined, activeProject?.slug ?? null);
      mergeSessionRecord(nextSession, { select: false });
      setPendingSessionOpenRequest(null);
      if (!options?.chatAgentId) {
        setSelectedSessionId(nextSession.id);
      }

      if (options?.chatAgentId) {
        setChatSessionId(nextSession.id);
        chatSessionAgentIdRef.current = options.chatAgentId;
        lastKnownChatSessionIdRef.current = nextSession.id;
        lastKnownChatSessionAgentIdRef.current = options.chatAgentId;
        void loadChatAgents({ background: true });
      }
    } catch (error) {
      setSessionActionError(await reportUiError(orchestraClient, "ui.sessions.create_contextual", error, "Unable to create a new session."));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCompactExistingSession(sessionId?: string | null) {
    if (!sessionId) {
      return;
    }
    void runSessionAction(async () => orchestraClient.sessions.compact(sessionId));
  }

  const handleReloadExistingSession = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }
    void runSessionAction(async () => orchestraClient.sessions.reload(sessionId));
  }, [runSessionAction]);

  const handleSelectedSessionModelChange = useCallback((value: string) => {
    if (selectedSession) {
      void handleModelChange(selectedSession.id, value);
    }
  }, [handleModelChange, selectedSession?.id]);
  const handleSelectedSessionDraftChange = useCallback((value: string) => {
    if (selectedSession) {
      updateDraftMessage(selectedSession.id, value);
    }
  }, [selectedSession?.id, updateDraftMessage]);
  const handleSelectedSessionSend = useCallback(() => {
    if (selectedSession?.terminalAttached) {
      return;
    }
    if (selectedSession) {
      handleSendMessage(selectedSession.id);
    }
  }, [handleSendMessage, selectedSession?.id, selectedSession?.terminalAttached]);
  const handleSelectedSessionStop = useCallback(() => {
    if (selectedSession) {
      handleStopSession(selectedSession.id);
    }
  }, [handleStopSession, selectedSession?.id]);
  const handleSelectedSessionCompact = useCallback(() => {
    if (selectedSession?.terminalAttached) {
      return;
    }
    handleCompactExistingSession(selectedSession?.id);
  }, [selectedSession?.id, selectedSession?.terminalAttached]);
  const handleSelectedSessionReload = useCallback(() => {
    if (selectedSession?.terminalAttached) {
      return;
    }
    handleReloadExistingSession(selectedSession?.id);
  }, [handleReloadExistingSession, selectedSession?.id, selectedSession?.terminalAttached]);

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
  }, [draftMessages, isDetachedWindow, pendingRuns, sessions, supervisorSessionId]);

  useEffect(() => {
    const handleUnhandledError = (event: ErrorEvent) => {
      void orchestraClient.app.reportError("ui.unhandled_error", event.error ?? event.message, "Unhandled UI error.");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      void orchestraClient.app.reportError("ui.unhandled_rejection", event.reason, "Unhandled promise rejection.");
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
      <ExplanatoryTooltipsProvider enabled={explanatoryTooltipsEnabled}>
        <main className="logs-window-shell" data-theme={themeId} data-theme-kind={activeTheme.kind}>
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
      </ExplanatoryTooltipsProvider>
    );
  }

  if (isAgentTerminalWindow && agentTerminalSessionId) {
    return <AgentTerminalWindowPage sessionId={agentTerminalSessionId} />;
  }

  return (
    <ExplanatoryTooltipsProvider enabled={explanatoryTooltipsEnabled}>
      <div
        className="app-shell"
        data-theme={themeId}
        data-theme-kind={activeTheme.kind}
        data-active-page={activePage}
        data-mobile-navigation={isMobileNavigation ? "true" : "false"}
        data-sidebar-collapsed={!isMobileNavigation && isSidebarCollapsed ? "true" : "false"}
      >
        {isMobileNavigation ? (
          <>
            <div className={activeTasksMobileHeaderContext ? "mobile-topbar mobile-topbar--subpage" : "mobile-topbar"} data-role="mobile-topbar">
              {activeTasksMobileHeaderContext ? (
                <>
                  <button
                    className="mobile-topbar__back"
                    data-role="mobile-subpage-back"
                    type="button"
                    aria-label={activeTasksMobileHeaderContext.backLabel}
                    onClick={() => tasksMobileHeaderContextRef.current?.onBack()}
                  >
                    <span className="mobile-topbar__back-icon" aria-hidden="true">←</span>
                  </button>
                  <div className="mobile-topbar__title-slot" data-role="mobile-topbar-title-slot" aria-label={activeTasksMobileHeaderContext.title}>
                    {activeTasksMobileHeaderContext.actions?.length ? (
                      <div className="mobile-topbar__title-actions" data-role="mobile-topbar-actions">
                        <TaskActionMenu
                          actions={activeTasksMobileHeaderContext.actions.map((action) => ({
                            ...action,
                            onClick: () => tasksMobileHeaderContextRef.current?.onAction?.(action.id),
                          }))}
                          menuLabel={activeTasksMobileHeaderContext.actionMenuLabel ?? "Actions"}
                        />
                      </div>
                    ) : (
                      <div className="mobile-topbar__copy">
                        <strong>{activeTasksMobileHeaderContext.title}</strong>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="mobile-topbar__brand" data-role="mobile-topbar-brand">
                    <div className="sidebar__brand-mark" aria-hidden="true">O</div>
                    <div className="mobile-topbar__copy">
                      <strong>Orchestra</strong>
                    </div>
                  </div>
                  <div className="mobile-topbar__project-switcher" data-role="mobile-topbar-project-switcher">
                    <ProjectSwitcher
                      projects={projects}
                      activeProjectId={activeProject?.id ?? null}
                      unreadCountsByProject={projectUnreadCounts}
                      hasUnreadOutsideActiveProject={hasUnreadOutsideActiveProject && activeProjectUnreadCount === 0}
                      collapsed={false}
                      onSelectProject={handleProjectSelection}
                      variant="mobile-topbar"
                    />
                  </div>
                </>
              )}
              <button
                ref={mobileNavigationTriggerRef}
                className="mobile-topbar__toggle"
                data-role="toggle-mobile-navigation"
                type="button"
                aria-label={isMobileNavigationOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={isMobileNavigationOpen}
                aria-controls={MOBILE_NAVIGATION_DIALOG_ID}
                onClick={() => {
                  if (isMobileNavigationOpen) {
                    closeMobileNavigation({ restoreFocus: true });
                    return;
                  }
                  setIsMobileNavigationOpen(true);
                }}
              >
                <span className="mobile-topbar__toggle-icon" aria-hidden="true">{isMobileNavigationOpen ? "✕" : "☰"}</span>
              </button>
            </div>

            {isMobileNavigationOpen ? (
              <div className="mobile-navigation" data-role="mobile-navigation-overlay">
                <button
                  className="mobile-navigation__backdrop"
                  data-role="mobile-navigation-backdrop"
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => closeMobileNavigation({ restoreFocus: true })}
                />
                <div
                  ref={mobileNavigationDialogRef}
                  className="mobile-navigation__sheet"
                  data-role="mobile-navigation-sheet"
                  id={MOBILE_NAVIGATION_DIALOG_ID}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="mobile-navigation-title"
                  tabIndex={-1}
                >
                  <div className="mobile-navigation__header">
                    <div>
                      <p className="eyebrow">Navigation</p>
                      <h2 id="mobile-navigation-title">Orchestra menu</h2>
                    </div>
                    <button
                      ref={mobileNavigationCloseButtonRef}
                      className="secondary-button"
                      type="button"
                      onClick={() => closeMobileNavigation({ restoreFocus: true })}
                    >
                      Close
                    </button>
                  </div>

                  <div className="mobile-navigation__body">
                    <section className="mobile-navigation__section">
                      <span className="mobile-navigation__section-label">Project</span>
                      <ProjectSwitcher
                        projects={projects}
                        activeProjectId={activeProject?.id ?? null}
                        unreadCountsByProject={projectUnreadCounts}
                        hasUnreadOutsideActiveProject={hasUnreadOutsideActiveProject && activeProjectUnreadCount === 0}
                        collapsed={false}
                        onSelectProject={handleProjectSelection}
                      />
                    </section>

                    <section className="mobile-navigation__section">
                      <span className="mobile-navigation__section-label">Navigate</span>
                      <nav className="primary-nav mobile-navigation__primary" aria-label="Mobile primary">
                        {mobileNavItems.map((item) => {
                          const badgeText = navBadgeByPage[item.id];
                          return (
                            <button
                              key={item.id}
                              className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                              type="button"
                              data-role={`nav-item-${item.id}`}
                              aria-label={item.label}
                              aria-current={item.id === activePage ? "page" : undefined}
                              title={item.label}
                              onClick={() => handlePrimaryNavigationSelection(item.id)}
                            >
                              <span className="nav-item__icon" aria-hidden="true">
                                <NavIcon pageId={item.id} className="nav-item__icon-svg" />
                              </span>
                              <span className="nav-item__label">{item.label}</span>
                              {badgeText ? <span className="status-badge status-badge--warning status-badge--compact nav-item__badge" data-role={`nav-badge-${item.id}`}>{badgeText}</span> : null}
                            </button>
                          );
                        })}
                      </nav>
                    </section>

                    {activePage === "chat" ? (
                      <section className="mobile-navigation__section">
                        <span className="mobile-navigation__section-label">Chat agents</span>
                        <div className="settings-subnav settings-subnav--mobile" role="tablist" aria-label="Chat agents">
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
                              onClick={() => handleChatAgentSelection(agentSnapshot.agent.id)}
                            >
                              {agentSnapshot.agent.name}
                            </button>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {activePage === "settings" ? (
                      <section className="mobile-navigation__section">
                        <span className="mobile-navigation__section-label">Settings sections</span>
                        <div
                          className="settings-subnav settings-subnav--settings settings-subnav--mobile"
                          data-role="settings-sections-subnav"
                          role="tablist"
                          aria-label="Settings sections"
                        >
                          {visibleSettingsTabs.map((tab) => (
                            <button
                              key={tab.id}
                              className={activeSettingsTab === tab.id ? "settings-subnav__item settings-subnav__item--active" : "settings-subnav__item"}
                              data-role={`settings-tab-${tab.id}`}
                              type="button"
                              role="tab"
                              aria-selected={activeSettingsTab === tab.id}
                              onClick={() => handleSettingsTabSelection(tab.id)}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <aside className="sidebar">
            <div className="sidebar__top">
              {isSidebarCollapsed ? (
                <div className="sidebar__collapsed-header" data-role="sidebar-collapsed-header">
                  <button
                    className="sidebar__collapse-toggle"
                    data-role="toggle-sidebar-collapse"
                    type="button"
                    aria-label="Expand navigation"
                    aria-expanded={false}
                    {...getExplanatoryTooltipProps(
                      "Expand the sidebar so labels and navigation details are visible again.",
                      explanatoryTooltipsEnabled,
                    )}
                    title={explanatoryTooltipsEnabled ? "Expand navigation" : undefined}
                    onClick={() => setIsSidebarCollapsed((current) => !current)}
                  >
                    »
                  </button>
                </div>
              ) : (
                <div className="sidebar__brand" data-role="app-brand">
                  <div className="sidebar__brand-mark" aria-hidden="true">O</div>
                  <div className="sidebar__brand-copy">
                    <strong>Orchestra</strong>
                    <span>Operator workbench</span>
                  </div>
                  <button
                    className="sidebar__collapse-toggle"
                    data-role="toggle-sidebar-collapse"
                    type="button"
                    aria-label="Collapse navigation"
                    aria-expanded={true}
                    {...getExplanatoryTooltipProps(
                      "Collapse the sidebar to make more room for your work.",
                      explanatoryTooltipsEnabled,
                    )}
                    title={explanatoryTooltipsEnabled ? "Collapse navigation" : undefined}
                    onClick={() => setIsSidebarCollapsed((current) => !current)}
                  >
                    «
                  </button>
                </div>
              )}

              <ProjectSwitcher
                projects={projects}
                activeProjectId={activeProject?.id ?? null}
                unreadCountsByProject={projectUnreadCounts}
                hasUnreadOutsideActiveProject={hasUnreadOutsideActiveProject && activeProjectUnreadCount === 0}
                collapsed={isSidebarCollapsed}
                onSelectProject={handleProjectSelection}
              />

              <nav className="primary-nav" aria-label="Primary">
                {activeNavItems.map((item) => {
                  const badgeText = navBadgeByPage[item.id];
                  return item.id === "chat" ? (
                    <div className="settings-nav" key={item.id}>
                      <button
                        className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                        type="button"
                        data-role={`nav-item-${item.id}`}
                        aria-label={item.label}
                        aria-current={item.id === activePage ? "page" : undefined}
                        title={item.label}
                        onClick={() => setActivePage(item.id)}
                      >
                        <span className="nav-item__icon" aria-hidden="true">
                          <NavIcon pageId={item.id} className="nav-item__icon-svg" />
                        </span>
                        <span className="nav-item__label">{item.label}</span>
                        {badgeText ? <span className={isSidebarCollapsed ? "status-badge status-badge--warning status-badge--compact status-badge--rail nav-item__badge" : "status-badge status-badge--warning status-badge--compact nav-item__badge"} data-role={`nav-badge-${item.id}`}>{badgeText}</span> : null}
                      </button>

                      {activePage === "chat" && !isSidebarCollapsed ? (
                        <div className="settings-subnav" data-role="chat-agent-sidebar-nav" role="tablist" aria-label="Chat agents">
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
                      data-role={`nav-item-${item.id}`}
                      aria-label={item.label}
                      aria-current={item.id === activePage ? "page" : undefined}
                      title={item.label}
                      onClick={() => {
                        if (item.id === "tasks") {
                          navigateToTasksOverview();
                          return;
                        }
                        setActivePage(item.id);
                      }}
                    >
                      <span className="nav-item__icon" aria-hidden="true">
                        <NavIcon pageId={item.id} className="nav-item__icon-svg" />
                      </span>
                      <span className="nav-item__label">{item.label}</span>
                      {badgeText ? <span className={isSidebarCollapsed ? "status-badge status-badge--warning status-badge--compact status-badge--rail nav-item__badge" : "status-badge status-badge--warning status-badge--compact nav-item__badge"} data-role={`nav-badge-${item.id}`}>{badgeText}</span> : null}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="sidebar__bottom">
              <div className="settings-nav">
                <button
                  className={activePage === "settings" ? "nav-item nav-item--active" : "nav-item"}
                  type="button"
                  data-role="nav-item-settings"
                  aria-label="Settings"
                  aria-current={activePage === "settings" ? "page" : undefined}
                  title="Settings"
                  onClick={() => setActivePage("settings")}
                >
                  <span className="nav-item__icon" aria-hidden="true">
                    <NavIcon pageId="settings" className="nav-item__icon-svg" />
                  </span>
                  <span className="nav-item__label">Settings</span>
                </button>

                {activePage === "settings" && !isSidebarCollapsed ? (
                  <div
                    ref={settingsSubnavRef}
                    className="settings-subnav settings-subnav--settings"
                    data-role="settings-sections-subnav"
                    role="tablist"
                    aria-label="Settings sections"
                  >
                    {visibleSettingsTabs.map((tab) => (
                      <button
                        key={tab.id}
                        className={activeSettingsTab === tab.id ? "settings-subnav__item settings-subnav__item--active" : "settings-subnav__item"}
                        data-role={`settings-tab-${tab.id}`}
                        type="button"
                        role="tab"
                        aria-selected={activeSettingsTab === tab.id}
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
        )}

        <main className={activePage === "chat" || activePage === "sessions" ? "content content--fill-page" : "content"}>
          <div className={activePage === "chat" || activePage === "sessions" ? "content__body content__body--fill" : "content__body"}>
          <ConnectionStatusBanner
            connection={connection}
            onRetry={() => {
              void loadSessions({ background: activePage === "sessions" || activePage === "chat" });
            }}
            retryLabel="Retry connection"
            dataRole="app-connection-banner"
          />
          {appInfo?.dispatchBlockedReason ? (
          <div className="session-readonly-banner app-status-banner" data-role="dispatch-blocked-banner">
            <div>
              <strong>Dispatching disabled.</strong> {appInfo.dispatchBlockedReason}
            </div>
            <div className="action-cluster action-cluster--wrap">
              {canManageHarnessSettings ? (
                <button className="secondary-button" type="button" onClick={navigateToHarnessSettings}>
                  Open Settings → Harness
                </button>
              ) : null}
              <button className="secondary-button" type="button" data-role="retry-pi-health-check" onClick={() => void loadAppInfo()}>
                Retry check
              </button>
            </div>
          </div>
        ) : null}

        {appInfo?.piRuntimeDiagnostics.runtime.available && !appInfo.piRuntimeDiagnostics.auth.configured ? (
          <div className="session-readonly-banner app-status-banner" data-role="pi-auth-banner">
            <div>
              <strong>PI auth setup required.</strong> {appInfo.piRuntimeDiagnostics.auth.message}
            </div>
            {canManageHarnessSettings ? (
              <button className="secondary-button" type="button" onClick={() => setSettingsTab("harness")}>
                Open Harness settings
              </button>
            ) : null}
          </div>
        ) : null}

        {appInfo?.piRuntimeDiagnostics.addOns.blockedExtensions.length ? (
          <div className="session-readonly-banner app-status-banner" data-role="pi-addon-policy-banner">
            <div>
              <strong>Unsupported packaged-mode PI add-ons.</strong> {appInfo.piRuntimeDiagnostics.addOns.message}
            </div>
            {canManageHarnessSettings ? (
              <button className="secondary-button" type="button" onClick={() => setSettingsTab("harness")}>
                Review Harness settings
              </button>
            ) : null}
          </div>
        ) : null}

        {activePage === "settings" ? (
          activeSettingsTab === "projects" ? (
            <ProjectsPanel />
          ) : activeSettingsTab === "agents" ? (
            <AgentsPanel activeProjectId={activeProject?.id ?? null} piSetupState={piSetupState} onOpenPiSettings={canManageHarnessSettings ? navigateToHarnessSettings : undefined} onOpenSkill={canManageSkillsSettings ? navigateToSkill : undefined} />
          ) : activeSettingsTab === "roles" ? (
            <RolesPanel selectionRequest={rolesSelectionRequest} piSetupState={piSetupState} onOpenPiSettings={canManageHarnessSettings ? navigateToHarnessSettings : undefined} onOpenSkill={canManageSkillsSettings ? navigateToSkill : undefined} />
          ) : activeSettingsTab === "workflows" ? (
            <WorkflowsPanel activeProjectId={activeProject?.id ?? null} selectionRequest={workflowsSelectionRequest} onOpenSkill={canManageSkillsSettings ? navigateToSkill : undefined} />
          ) : activeSettingsTab === "skills" ? (
            <SkillsPanel selectionRequest={skillsSelectionRequest} />
          ) : activeSettingsTab === "channels" ? (
            <ChannelsPanel />
          ) : activeSettingsTab === "remote" ? (
            <RemotePanel />
          ) : activeSettingsTab === "source_control" ? (
            <SourceControlPanel />
          ) : activeSettingsTab === "prompting" ? (
            <PromptingPanel
              activeProjectName={activeProject?.name ?? null}
              sessionPromptSettings={sessionPromptSettings}
              onSaveSessionPromptTemplate={(template) => void handleSaveSessionPromptTemplate(template)}
            />
          ) : activeSettingsTab === "harness" ? (
            <HarnessPanel
              piRuntimeSettings={piRuntimeSettings}
              piRuntimeDiagnostics={appInfo?.piRuntimeDiagnostics ?? null}
              piSetupState={piSetupState}
              piOAuthFlowState={piOAuthFlowState}
              piModelsJson={piModelsJson}
              loadingPiSetup={loadingPiSetup}
              loadingPiModelsJson={loadingPiModelsJson}
              onRefresh={() => void refreshPiSetupState({ includeModelsJson: true })}
              onSaveProviderApiKey={(providerId, apiKey) => handleSavePiProviderApiKey(providerId, apiKey)}
              onRemoveProviderCredential={(providerId) => handleRemovePiProviderCredential(providerId)}
              onStartOAuthFlow={(providerId, methodId) => handleStartPiOAuthFlow(providerId, methodId)}
              onSubmitOAuthFlowInput={(value) => handleSubmitPiOAuthFlowInput(value)}
              onCancelOAuthFlow={() => handleCancelPiOAuthFlow()}
              onDismissOAuthFlow={() => handleDismissPiOAuthFlow()}
              onImportLegacyConfig={(replaceExisting) => handleImportPiLegacyConfig(replaceExisting)}
              onDismissLegacyImport={() => handleDismissPiLegacyImport()}
              onSaveModelsJson={(content) => handleSavePiModelsJson(content)}
              onSavePiRuntimeSettings={(input) => void handleSavePiRuntimeSettings(input)}
              onImportLegacyPiConfiguration={(input) => void handleImportLegacyPiConfiguration(input)}
            />
          ) : (
            <GeneralPanel
              availableThemes={BUILT_IN_ORCHESTRA_THEMES}
              selectedThemeId={themeId}
              canManageBridgeDiagnostics={canManageBridgeDiagnostics}
              canManageRuntimeLogs={canManageRuntimeLogs}
              canManageSystemNotifications={canManageSystemNotifications}
              canOpenLogsWindow={canOpenLogsWindow}
              bridgeDiagnostics={bridgeDiagnostics}
              localNotificationsEnabled={localNotificationsEnabled}
              systemNotificationEnvironment={systemNotificationEnvironment}
              systemNotificationPermission={systemNotificationPermission}
              refreshingSystemNotificationPermission={refreshingSystemNotificationPermission}
              requestingSystemNotificationPermission={requestingSystemNotificationPermission}
              sendingTestSystemNotification={sendingTestSystemNotification}
              loadingBridgeDiagnostics={loadingBridgeDiagnostics}
              refreshingBridgeDiagnostics={refreshingBridgeDiagnostics}
              logs={logs}
              loadingLogs={loadingLogs}
              clearingLogs={clearingLogs}
              exportingLogs={exportingLogs}
              logExportMessage={logExportMessage}
              logExportError={logExportError}
              includeRelatedSessionSnapshot={includeRelatedSessionSnapshot}
              explanatoryTooltipsEnabled={explanatoryTooltipsEnabled}
              onThemeChange={handleThemeChange}
              onToggleExplanatoryTooltips={handleExplanatoryTooltipsToggle}
              onRefreshBridgeDiagnostics={() => void loadBridgeDiagnostics({ background: true })}
              onCleanupStaleBridges={() => void handleCleanupStaleBridges()}
              onOpenLogsWindow={() => void handleOpenLogsWindow()}
              onOpenPromptingSettings={() => setSettingsTab("prompting")}
              onToggleLocalNotificationsEnabled={setLocalNotificationsEnabled}
              onRefreshSystemNotificationPermission={() => void handleRefreshSystemNotificationPermission()}
              onRequestSystemNotificationPermission={() => void handleRequestSystemNotificationPermission()}
              onSendTestSystemNotification={() => void handleSendTestSystemNotification()}
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
            supportsAgentTerminal={canUseAgentTerminal}
          />
        ) : activePage === "chat" ? (
          <AgentChatPage
            agent={selectedChatAgent}
            chatAgents={chatAgents.map((agentSnapshot) => agentSnapshot.agent)}
            selectedAgentId={selectedChatAgentId}
            session={chatSession}
            referenceTasks={referenceTasks}
            referenceAgents={referenceAgents}
            referenceRoles={referenceRoles}
            displayedEvents={displayedEvents}
            sessionPending={Boolean(chatSessionPendingRun)}
            sessionDisplayStatus={chatSessionDisplayStatus}
            selectedModelState={chatModelState}
            selectedSessionStats={viewedSession?.id === chatSession?.id ? viewedSessionStats : undefined}
            sessionReadOnly={Boolean(chatSession?.terminalAttached)}
            sessionMessageable={chatSession ? isSessionMessageable(chatSession) : true}
            loadingStatsSessionId={loadingStatsSessionId}
            loadingAgents={loadingChatAgents}
            loadingSession={Boolean(selectedChatAgent && loadingChatSessionAgentId === selectedChatAgent.id && !chatSession)}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            onSelectAgent={navigateToChatAgent}
            draftMessage={chatSessionDraftMessage}
            piSetupState={piSetupState}
            connection={connection}
            error={sessionActionError}
            onRetrySessionLoad={() => {
              void loadSessions();
            }}
            transcriptRef={transcriptRef}
            scrollState={sessionScrollState}
            onScrollLockChange={handleSessionScrollLockChange}
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
              if (chatSession?.terminalAttached || (chatSession && !isSessionMessageable(chatSession))) {
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
            onOpenTask={navigateToTask}
            onOpenAgent={navigateToChatAgent}
            onOpenRole={navigateToRole}
            onCreateNewSession={() => void handleCreateFreshSession(chatSession?.id, { chatAgentId: selectedChatAgent?.id ?? null })}
            onOpenPiSettings={canManageHarnessSettings ? navigateToHarnessSettings : undefined}
            onCompactSession={() => handleCompactExistingSession(chatSession?.terminalAttached ? null : chatSession?.id)}
            onReloadSession={() => handleReloadExistingSession(chatSession?.terminalAttached ? null : chatSession?.id)}
          />
        ) : activePage === "sessions" ? (
          <SessionsPage
            sessions={filteredSessions}
            referenceTasks={referenceTasks}
            referenceAgents={referenceAgents}
            referenceRoles={referenceRoles}
            sessionFilter={sessionFilter}
            onSessionFilterChange={setSessionFilter}
            selectedSession={selectedSession}
            displayedEvents={selectedSession?.events ?? []}
            selectedSessionPending={Boolean(selectedSessionPendingRun) || Boolean(pendingSelectedSessionId && !selectedSession)}
            selectedSessionDisplayStatus={selectedSessionDisplayStatus}
            selectedModelState={selectedModelState}
            selectedSessionStats={viewedSession?.id === selectedSession?.id ? viewedSessionStats : undefined}
            selectedSessionReadOnly={Boolean(selectedSession?.terminalAttached)}
            selectedSessionMessageable={selectedSession ? isSessionMessageable(selectedSession) : true}
            loadingSessions={loadingSessions}
            refreshingSessions={refreshingSessions}
            loadingStatsSessionId={loadingStatsSessionId}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            loadingRuntimeDetailsSessionId={loadingRuntimeDetailsSessionId}
            draftMessage={selectedSessionDraftMessage}
            piSetupState={piSetupState}
            connection={connection}
            sessionActionError={sessionActionError}
            onRetrySessions={() => {
              void loadSessions();
            }}
            transcriptRef={transcriptRef}
            scrollState={sessionScrollState}
            onScrollLockChange={handleSessionScrollLockChange}
            formatDateTime={formatDateTime}
            formatTimestamp={formatTimestamp}
            formatModelOptionLabel={formatModelOptionLabel}
            getStatusTone={getStatusTone}
            getEventTone={getEventTone}
            onSelectSession={(sessionId) => {
              setPendingSessionOpenRequest(null);
              setSelectedSessionId(sessionId);
            }}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
            onDeleteClosedSessions={() => void handleDeleteClosedSessions()}
            onModelChange={handleSelectedSessionModelChange}
            onDraftChange={handleSelectedSessionDraftChange}
            onSendMessage={handleSelectedSessionSend}
            onStopSession={handleSelectedSessionStop}
            onOpenTask={navigateToTask}
            onOpenAgent={navigateToChatAgent}
            onOpenRole={navigateToRole}
            onCreateNewSession={() => void handleCreateFreshSession(selectedSession?.id)}
            onCreateSession={() => void handleCreateSession()}
            createSessionDisabled={isSubmitting || Boolean(appInfo?.dispatchBlocked)}
            onOpenPiSettings={canManageHarnessSettings ? navigateToHarnessSettings : undefined}
            onCompactSession={handleSelectedSessionCompact}
            onReloadSession={handleSelectedSessionReload}
            onLoadRuntimeDetails={loadSelectedSessionRuntimeDetails}
          />
        ) : (
          <TasksPage
            createTaskProjectId={tasksCreateProjectId}
            createTaskToken={tasksCreateToken}
            key={activeProject?.id ?? "default"}
            openTaskRequest={tasksOpenRequest}
            projectId={activeProject?.id ?? null}
            taskOverviewState={taskOverviewState}
            tasksOverviewToken={tasksOverviewToken}
            onTaskOverviewStateChange={setTaskOverviewState}
            onSelectedTaskIdChange={setSelectedTaskId}
            onOpenTaskTag={navigateToTasksOverview}
            onOpenAgent={navigateToChatAgent}
            onOpenRole={navigateToRole}
            onOpenSession={navigateToSession}
            onMobileHeaderContextChange={handleTasksMobileHeaderContextChange}
          />
        )}
        </div>
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
        error={sessionActionError?.message ?? null}
        events={supervisorSession?.events ?? []}
        referenceTasks={referenceTasks}
        referenceAgents={referenceAgents}
        referenceRoles={referenceRoles}
        formatTimestamp={formatTimestamp}
        onClose={() => setSupervisorQuickChatOpen(false)}
        onDraftChange={(value) => {
          const draftSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
          if (draftSessionId) {
            updateDraftMessage(draftSessionId, value);
          }
        }}
        onOpenFullSession={() => {
          const targetSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
          if (targetSessionId) {
            setActivePage("sessions");
            setPendingSessionOpenRequest(null);
            setSelectedSessionId(targetSessionId);
            setSupervisorQuickChatOpen(false);
          }
        }}
        onOpenTask={navigateToTask}
        onOpenAgent={navigateToChatAgent}
        onOpenRole={navigateToRole}
        onSend={() => {
          const targetSessionId = supervisorSessionId ?? lastKnownSupervisorSessionIdRef.current;
          if (targetSessionId) {
            handleSendMessage(targetSessionId);
          }
        }}
        open={supervisorQuickChatOpen}
        pending={Boolean(supervisorPendingRun)}
        session={supervisorSession}
      />
      </div>
    </ExplanatoryTooltipsProvider>
  );
}
