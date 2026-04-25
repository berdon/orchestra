import { useEffect, useState, type RefObject } from "react";

import { ResourceStatusBanner } from "../components/ResourceStatusBanner";
import { SessionChatPanel } from "../components/SessionChatPanel";
import type { OrchestraConnectionSnapshot } from "../lib/orchestraClient";
import type { UiErrorState } from "../lib/orchestraData/errors";
import type {
  AgentDefinition,
  AgentSummary,
  PiSetupState,
  RoleSummary,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionStats,
  SessionScrollState,
  SessionStatus,
  TaskSummary,
} from "../types";

interface AgentChatPageProps {
  agent: AgentDefinition | null;
  chatAgents: Array<Pick<AgentDefinition, "id" | "name" | "slug">>;
  selectedAgentId: string | null;
  session: SessionRecord | null;
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  displayedEvents: SessionEvent[];
  sessionPending: boolean;
  sessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  selectedSessionStats?: SessionStats;
  sessionReadOnly?: boolean;
  sessionMessageable?: boolean;
  loadingStatsSessionId: string | null;
  loadingAgents: boolean;
  loadingSession: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  onSelectAgent: (agentId: string) => void;
  draftMessage: string;
  piSetupState?: PiSetupState | null;
  connection: OrchestraConnectionSnapshot;
  error: UiErrorState | null;
  onRetrySessionLoad: () => void;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
  onScrollLockChange: (lockedToBottom: boolean) => void;
  formatDateTime: (timestamp: string) => string;
  formatTimestamp: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  getStatusTone: (status: SessionStatus) => string;
  getEventTone: (kind: SessionEvent["kind"]) => string;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
  onOpenTask: (taskId: string, projectId?: string | null) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onCreateNewSession: () => void;
  onOpenPiSettings?: () => void;
  onCompactSession: () => void;
  onReloadSession: () => void;
}

export function AgentChatPage({
  agent,
  chatAgents,
  selectedAgentId,
  session,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  displayedEvents,
  sessionPending,
  sessionDisplayStatus,
  selectedModelState,
  selectedSessionStats,
  sessionReadOnly = false,
  sessionMessageable = true,
  loadingStatsSessionId,
  loadingAgents,
  loadingSession,
  loadingModelSessionId,
  changingModelSessionId,
  onSelectAgent,
  draftMessage,
  piSetupState,
  connection,
  error,
  onRetrySessionLoad,
  transcriptRef,
  scrollState,
  onScrollLockChange,
  formatDateTime,
  formatTimestamp,
  formatModelOptionLabel,
  getStatusTone,
  getEventTone,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
  onCreateNewSession,
  onOpenPiSettings,
  onCompactSession,
  onReloadSession,
}: AgentChatPageProps) {
  const [mobileAgentPickerOpen, setMobileAgentPickerOpen] = useState(false);

  useEffect(() => {
    setMobileAgentPickerOpen(false);
  }, [selectedAgentId]);

  const emptyStateLoading = !session && (loadingAgents || loadingSession);
  const mobileSwitcherBusy = loadingAgents || loadingSession;
  const mobileSwitcherLabel = mobileSwitcherBusy
    ? (loadingSession ? "Opening chat" : "Loading chat")
    : null;
  const mobileSwitcherStatus = loadingSession && agent
    ? `Opening ${agent.name}…`
    : loadingAgents
      ? "Loading available chat agents…"
      : null;

  let emptyStateTitle = "Choose a chat";
  let emptyStateDescription = "Select a named agent from the page picker or the desktop Chat sidebar to open or resume its main session.";

  if (loadingAgents) {
    emptyStateTitle = "Loading chat workspace";
    emptyStateDescription = "Fetching the available named agents and restoring the last chat selection.";
  } else if (!agent) {
    emptyStateTitle = "No agents available";
    emptyStateDescription = "Create a named agent in Settings → Agents to start chatting here.";
  } else if (loadingSession) {
    emptyStateTitle = `Opening ${agent.name}`;
    emptyStateDescription = "Restoring the agent’s main session and chat controls…";
  }

  const panelStackClassName = error
    ? "panel-stack panel-stack--sessions panel-stack--sessions-layout panel-stack--sessions-layout--with-error agent-chat-page"
    : "panel-stack panel-stack--sessions panel-stack--sessions-layout agent-chat-page";

  return (
    <section className={panelStackClassName}>
      <ResourceStatusBanner
        connection={connection}
        error={error}
        hasData={Boolean(session)}
        onRetry={onRetrySessionLoad}
        retryLabel="Retry chat"
        dataRolePrefix="agent-chat-status"
      />
      <div
        className={mobileSwitcherBusy ? "page-mobile-switcher page-mobile-switcher--chat page-mobile-switcher--loading" : "page-mobile-switcher page-mobile-switcher--chat"}
        data-role="chat-mobile-agent-switcher"
        aria-busy={mobileSwitcherBusy}
      >
        {mobileSwitcherLabel ? <p className="eyebrow">{mobileSwitcherLabel}</p> : null}
        <button
          className="page-mobile-switcher__trigger"
          type="button"
          data-role="chat-mobile-agent-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={mobileAgentPickerOpen}
          disabled={loadingAgents && chatAgents.length === 0}
          onClick={() => setMobileAgentPickerOpen((current) => !current)}
        >
          <span className="page-mobile-switcher__current">
            {agent?.name ?? (loadingAgents ? "Loading agents…" : "Choose an agent")}
          </span>
          <span className="page-mobile-switcher__chevron" aria-hidden="true">▾</span>
        </button>
        {mobileSwitcherStatus ? <p className="page-mobile-switcher__hint page-mobile-switcher__hint--status" data-role="chat-mobile-agent-switcher-status">{mobileSwitcherStatus}</p> : null}
        {mobileAgentPickerOpen ? (
          <div className="page-mobile-switcher__sheet" data-role="chat-mobile-agent-picker">
            <div className="page-mobile-switcher__list" role="listbox" aria-label="Chat agents">
              {loadingAgents ? <p className="page-mobile-switcher__hint">Loading agents…</p> : null}
              {!loadingAgents && chatAgents.length === 0 ? <p className="page-mobile-switcher__hint">No agents available yet.</p> : null}
              {chatAgents.map((chatAgent) => (
                <button
                  key={chatAgent.id}
                  className={selectedAgentId === chatAgent.id ? "page-mobile-switcher__item page-mobile-switcher__item--active" : "page-mobile-switcher__item"}
                  type="button"
                  role="option"
                  aria-selected={selectedAgentId === chatAgent.id}
                  data-role={`chat-mobile-agent-option-${chatAgent.slug}`}
                  onClick={() => {
                    setMobileAgentPickerOpen(false);
                    onSelectAgent(chatAgent.id);
                  }}
                >
                  {chatAgent.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="session-detail-column session-detail-column--standalone">
        <SessionChatPanel
          session={session}
          title={agent ? `${agent.name} chat` : null}
          referenceTasks={referenceTasks}
          referenceAgents={referenceAgents}
          referenceRoles={referenceRoles}
          displayedEvents={displayedEvents}
          sessionPending={sessionPending}
          sessionDisplayStatus={sessionDisplayStatus}
          selectedModelState={selectedModelState}
          selectedSessionStats={selectedSessionStats}
          sessionReadOnly={sessionReadOnly}
          sessionMessageable={sessionMessageable}
          loadingStatsSessionId={loadingStatsSessionId}
          loadingModelSessionId={loadingModelSessionId}
          changingModelSessionId={changingModelSessionId}
          draftMessage={draftMessage}
          piSetupState={piSetupState}
          transcriptRef={transcriptRef}
          scrollState={scrollState}
          onScrollLockChange={onScrollLockChange}
          formatDateTime={formatDateTime}
          formatTimestamp={formatTimestamp}
          formatModelOptionLabel={formatModelOptionLabel}
          getStatusTone={getStatusTone}
          getEventTone={getEventTone}
          onModelChange={onModelChange}
          onDraftChange={onDraftChange}
          onSendMessage={onSendMessage}
          onStopSession={onStopSession}
          onOpenTask={onOpenTask}
          onOpenAgent={onOpenAgent}
          onOpenRole={onOpenRole}
          onCreateNewSession={onCreateNewSession}
          onOpenPiSettings={onOpenPiSettings}
          onCompactSession={onCompactSession}
          onReloadSession={onReloadSession}
          emptyStateEyebrow="Chat"
          emptyStateTitle={emptyStateTitle}
          emptyStateDescription={emptyStateDescription}
          emptyStateLoading={emptyStateLoading}
          surface="chat-page"
        />
      </div>
    </section>
  );
}
