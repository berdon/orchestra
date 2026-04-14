import type { RefObject } from "react";

import { SessionChatPanel } from "../components/SessionChatPanel";
import type {
  AgentDefinition,
  AgentSummary,
  RoleSummary,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionScrollState,
  SessionStatus,
  TaskSummary,
} from "../types";

interface AgentChatPageProps {
  agent: AgentDefinition | null;
  session: SessionRecord | null;
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  displayedEvents: SessionEvent[];
  sessionPending: boolean;
  sessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  sessionReadOnly?: boolean;
  loadingAgents: boolean;
  loadingSession: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  error: string | null;
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
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onCreateNewSession: () => void;
  onCompactSession: () => void;
}

export function AgentChatPage({
  agent,
  session,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  displayedEvents,
  sessionPending,
  sessionDisplayStatus,
  selectedModelState,
  sessionReadOnly = false,
  loadingAgents,
  loadingSession,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  error,
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
  onCompactSession,
}: AgentChatPageProps) {
  let emptyStateTitle = "Choose an agent chat";
  let emptyStateDescription = "Select a named agent from the Chat sidebar to open or resume its main session.";

  if (loadingAgents) {
    emptyStateTitle = "Loading agents";
    emptyStateDescription = "Fetching named agents for chat…";
  } else if (!agent) {
    emptyStateTitle = "No agents available";
    emptyStateDescription = "Create a named agent in Settings → Agents to start chatting here.";
  } else if (loadingSession) {
    emptyStateTitle = `Opening ${agent.name}`;
    emptyStateDescription = "Loading the agent’s main session…";
  }

  return (
    <section className="panel-stack panel-stack--sessions">
      {error ? <p className="error-copy">{error}</p> : null}
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
          sessionReadOnly={sessionReadOnly}
          loadingModelSessionId={loadingModelSessionId}
          changingModelSessionId={changingModelSessionId}
          draftMessage={draftMessage}
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
          onCompactSession={onCompactSession}
          emptyStateEyebrow="Agent chat"
          emptyStateTitle={emptyStateTitle}
          emptyStateDescription={emptyStateDescription}
        />
      </div>
    </section>
  );
}
