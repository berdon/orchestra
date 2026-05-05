import { useEffect, useRef, useState, type RefObject } from "react";

import { ResourceStatusBanner } from "../components/ResourceStatusBanner";
import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SessionChatPanel } from "../components/SessionChatPanel";
import { SessionTranscriptMobileControlsMenu } from "../components/SessionTranscriptMobileControlsMenu";
import type { OrchestraConnectionSnapshot } from "../lib/orchestraClient";
import type { UiErrorState } from "../lib/orchestraData/errors";
import { getSessionListMetadata, getSessionListTitle } from "../lib/sessionList";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { AgentSummary, PiSetupState, RoleSummary, SessionActivityState, SessionEvent, SessionModelState, SessionRecord, SessionScrollState, SessionStats, SessionStatus, TaskSummary } from "../types";

function formatListControlLabel(session: SessionRecord) {
  if (session.controlOperation?.status !== "running") {
    return null;
  }
  return session.controlOperation.kind === "compact"
    ? (session.controlOperation.trigger === "auto" ? "Auto-compacting" : "Compacting")
    : "Reloading";
}

function formatActivityLabel(activityState?: SessionActivityState, activeToolName?: string | null) {
  switch (activityState) {
    case "thinking":
      return "Thinking";
    case "tool_running":
      return activeToolName ? `Running ${activeToolName}` : "Running tool";
    case "streaming":
      return "Streaming";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function getActivityTone(activityState?: SessionActivityState) {
  switch (activityState) {
    case "streaming":
      return "success";
    case "tool_running":
    case "thinking":
      return "accent";
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

interface SessionsPageProps {
  sessions: SessionRecord[];
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  sessionFilter: "active" | "closed";
  onSessionFilterChange: (value: "active" | "closed") => void;
  selectedSession: SessionRecord | null;
  displayedEvents: SessionEvent[];
  selectedSessionPending: boolean;
  selectedSessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  selectedSessionStats?: SessionStats;
  selectedSessionReadOnly?: boolean;
  selectedSessionMessageable?: boolean;
  loadingSessions: boolean;
  refreshingSessions: boolean;
  loadingStatsSessionId: string | null;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  piSetupState?: PiSetupState | null;
  connection: OrchestraConnectionSnapshot;
  sessionActionError: UiErrorState | null;
  onRetrySessions: () => void;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
  onScrollLockChange: (lockedToBottom: boolean) => void;
  formatDateTime: (timestamp: string) => string;
  formatTimestamp: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  getStatusTone: (status: SessionStatus) => string;
  getEventTone: (kind: SessionEvent["kind"]) => string;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteClosedSessions: () => void;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
  onOpenTask: (taskId: string, projectId?: string | null) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onCreateNewSession: () => void;
  onCreateSession?: () => void;
  createSessionDisabled?: boolean;
  onOpenPiSettings?: () => void;
  onCompactSession: () => void;
  onReloadSession: () => void;
}

export function SessionsPage({
  sessions,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  sessionFilter,
  onSessionFilterChange,
  selectedSession,
  displayedEvents,
  selectedSessionPending,
  selectedSessionDisplayStatus,
  selectedModelState,
  selectedSessionStats,
  selectedSessionReadOnly = false,
  selectedSessionMessageable = true,
  loadingSessions,
  refreshingSessions,
  loadingStatsSessionId,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  piSetupState,
  connection,
  sessionActionError,
  onRetrySessions,
  transcriptRef,
  scrollState,
  onScrollLockChange,
  formatDateTime,
  formatTimestamp,
  formatModelOptionLabel,
  getStatusTone,
  getEventTone,
  onSelectSession,
  onDeleteSession,
  onDeleteClosedSessions,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
  onCreateNewSession,
  onCreateSession,
  createSessionDisabled = false,
  onOpenPiSettings,
  onCompactSession,
  onReloadSession,
}: SessionsPageProps) {
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [revealedDeleteSessionId, setRevealedDeleteSessionId] = useState<string | null>(null);
  const [mobileSessionPickerOpen, setMobileSessionPickerOpen] = useState(false);
  const [mobileTranscriptControlsOpen, setMobileTranscriptControlsOpen] = useState(false);
  const [wrapTranscript, setWrapTranscript] = useState(true);
  const [compactSessionLayout, setCompactSessionLayout] = useState(
    () => (typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1100px)").matches
      : false),
  );
  const [touchFriendlySessionListActions, setTouchFriendlySessionListActions] = useState(
    () => (typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1100px), (hover: none), (pointer: coarse)").matches
      : false),
  );
  const revealTimerRef = useRef<number | null>(null);
  const canShowDebugInfo = (import.meta.env.DEV || navigator.webdriver) && Boolean(selectedSession?.debugInfo);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    setShowDebugInfo(false);
  }, [selectedSession?.id]);

  useEffect(() => () => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const compactLayoutMediaQuery = window.matchMedia("(max-width: 1100px)");
    const touchFriendlyMediaQuery = window.matchMedia("(max-width: 1100px), (hover: none), (pointer: coarse)");
    const updateCompactSessionLayout = () => {
      setCompactSessionLayout(compactLayoutMediaQuery.matches);
    };
    const updateTouchFriendlySessionListActions = () => {
      setTouchFriendlySessionListActions(touchFriendlyMediaQuery.matches);
    };

    updateCompactSessionLayout();
    updateTouchFriendlySessionListActions();
    compactLayoutMediaQuery.addEventListener("change", updateCompactSessionLayout);
    touchFriendlyMediaQuery.addEventListener("change", updateTouchFriendlySessionListActions);
    return () => {
      compactLayoutMediaQuery.removeEventListener("change", updateCompactSessionLayout);
      touchFriendlyMediaQuery.removeEventListener("change", updateTouchFriendlySessionListActions);
    };
  }, []);

  useEffect(() => {
    setMobileSessionPickerOpen(false);
    setMobileTranscriptControlsOpen(false);
  }, [selectedSession?.id, sessionFilter]);

  function handleTranscriptAutoScrollToggle() {
    const nextLockedState = !scrollState.lockedToBottom;
    const node = transcriptRef.current;

    if (nextLockedState && node) {
      node.scrollTop = node.scrollHeight;
    }

    onScrollLockChange(nextLockedState);
  }

  function scheduleDeleteReveal(sessionId: string) {
    if (touchFriendlySessionListActions) {
      setRevealedDeleteSessionId(sessionId);
      return;
    }
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
    }
    setRevealedDeleteSessionId(null);
    revealTimerRef.current = window.setTimeout(() => {
      setRevealedDeleteSessionId(sessionId);
      revealTimerRef.current = null;
    }, 2000);
  }

  function hideDeleteReveal() {
    if (touchFriendlySessionListActions) {
      return;
    }
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setRevealedDeleteSessionId(null);
  }

  function renderSessionFilterTabs(className?: string) {
    return (
      <div className={className ? `filter-chip-row ${className}` : "filter-chip-row"} role="tablist" aria-label="Session filters">
        <button
          type="button"
          role="tab"
          data-role="session-filter-active"
          aria-selected={sessionFilter === "active"}
          className={sessionFilter === "active" ? "filter-chip filter-chip--active" : "filter-chip"}
          onClick={() => onSessionFilterChange("active")}
        >
          Active
        </button>
        <button
          type="button"
          role="tab"
          data-role="session-filter-closed"
          aria-selected={sessionFilter === "closed"}
          className={sessionFilter === "closed" ? "filter-chip filter-chip--active" : "filter-chip"}
          onClick={() => onSessionFilterChange("closed")}
        >
          Closed
        </button>
      </div>
    );
  }

  function renderSessionList({ mobile = false, hintClassName = "muted-copy" }: { mobile?: boolean; hintClassName?: string } = {}) {
    return (
      <div className="session-list-scroll">
        <nav className="session-list" aria-label="Sessions">
          {loadingSessions && sessions.length === 0 ? <p className={hintClassName}>Loading sessions…</p> : null}
          {!loadingSessions && sessions.length === 0 ? <p className={hintClassName}>No {sessionFilter} sessions.</p> : null}
          {sessions.map((session) => {
            const isActive = session.id === selectedSession?.id;
            const showDeleteAction = touchFriendlySessionListActions || revealedDeleteSessionId === session.id;
            return (
              <div
                key={session.id}
                className={[
                  "session-list-row",
                  isActive ? "session-list-row--active" : "",
                  showDeleteAction ? "session-list-row--actions-visible" : "",
                ].filter(Boolean).join(" ")}
                onMouseEnter={() => scheduleDeleteReveal(session.id)}
                onMouseLeave={hideDeleteReveal}
                onFocusCapture={() => setRevealedDeleteSessionId(session.id)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    hideDeleteReveal();
                  }
                }}
              >
                <a
                  data-role="session-link"
                  data-session-id={session.id}
                  className={isActive ? "session-list-link session-list-link--active" : "session-list-link"}
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onSelectSession(session.id);
                    if (mobile) {
                      setMobileSessionPickerOpen(false);
                    }
                  }}
                >
                  <div className="session-list-link__header">
                    <span className="session-list-link__meta">{getSessionListMetadata(session)}</span>
                    <span className={`status-badge status-badge--${session.terminalAttached ? "warning" : formatListControlLabel(session) ? "accent" : getActivityTone(session.activityState)}`}>
                      {session.terminalAttached
                        ? "Terminal attached"
                        : formatListControlLabel(session) ?? formatActivityLabel(session.activityState, session.activeToolName)}
                    </span>
                  </div>
                  <span className="session-list-link__title">{getSessionListTitle(session)}</span>
                </a>
                <button
                  className="session-delete-button"
                  type="button"
                  tabIndex={showDeleteAction ? 0 : -1}
                  aria-label={`Dismiss ${getSessionListTitle(session)}`}
                  {...getTooltipProps("Hide this session from the list without deleting its stored history.")}
                  onClick={() => onDeleteSession(session.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </nav>
      </div>
    );
  }

  function renderClosedSessionsFooter(className?: string) {
    if (sessionFilter !== "closed") {
      return null;
    }

    return (
      <div className={className ?? "session-list-footer"}>
        <button className="secondary-button secondary-button--danger" data-role="delete-closed-sessions" type="button" onClick={onDeleteClosedSessions}>
          Dismiss closed
        </button>
      </div>
    );
  }

  function renderSessionNavigationPanel() {
    return (
      <>
        <ResourceStatusBanner
          connection={connection}
          error={sessionActionError}
          hasData={sessions.length > 0}
          refreshing={refreshingSessions}
          onRetry={onRetrySessions}
          retryLabel="Retry sessions"
          refreshingLabel="Refreshing sessions…"
          dataRolePrefix="sessions-status"
        />
        {renderSessionFilterTabs()}
        {renderSessionList()}
        {renderClosedSessionsFooter()}
      </>
    );
  }

  function renderMobileSessionPicker() {
    return (
      <div className="sessions-mobile-picker">
        {renderSessionFilterTabs("sessions-mobile-picker__filters")}
        {renderSessionList({ mobile: true, hintClassName: "page-mobile-switcher__hint" })}
        {renderClosedSessionsFooter("session-list-footer sessions-mobile-picker__footer")}
      </div>
    );
  }

  const selectedSessionPickerLabel = selectedSession ? getSessionListTitle(selectedSession) : `Choose ${sessionFilter} session`;
  const showCreateSessionFab = Boolean(onCreateSession && (!compactSessionLayout || mobileSessionPickerOpen || !selectedSession));

  return (
    <section className={showCreateSessionFab
      ? "panel-stack panel-stack--sessions panel-stack--sessions-layout sessions-page task-page-stack--with-fab"
      : "panel-stack panel-stack--sessions panel-stack--sessions-layout sessions-page"}
    >
      <div className="page-mobile-switcher page-mobile-switcher--sessions" data-role="sessions-mobile-switcher">
        <div className="page-mobile-switcher__row">
          <button
            className="page-mobile-switcher__trigger"
            type="button"
            data-role="sessions-mobile-picker-trigger"
            aria-haspopup="dialog"
            aria-expanded={mobileSessionPickerOpen}
            onClick={() => {
              setMobileTranscriptControlsOpen(false);
              setMobileSessionPickerOpen((current) => !current);
            }}
          >
            <span className="page-mobile-switcher__current" title={selectedSessionPickerLabel}>
              {selectedSessionPickerLabel}
            </span>
            <span className="page-mobile-switcher__chevron" aria-hidden="true">▾</span>
          </button>
          <SessionTranscriptMobileControlsMenu
            open={mobileTranscriptControlsOpen}
            disabled={!selectedSession}
            onOpenChange={(open) => {
              if (open) {
                setMobileSessionPickerOpen(false);
              }
              setMobileTranscriptControlsOpen(open);
            }}
            autoScrollEnabled={scrollState.lockedToBottom}
            wrapEnabled={wrapTranscript}
            onToggleAutoScroll={handleTranscriptAutoScrollToggle}
            onToggleWrap={() => setWrapTranscript((current) => !current)}
            onOpenTask={selectedSession?.activeTaskId
              ? () => onOpenTask(
                selectedSession.activeTaskId as string,
                selectedSession.activeTaskProjectId ?? selectedSession.taskProjectId ?? null,
              )
              : undefined}
          />
        </div>
        {mobileSessionPickerOpen ? (
          <div className="page-mobile-switcher__sheet" data-role="sessions-mobile-picker">
            {renderMobileSessionPicker()}
          </div>
        ) : null}
      </div>
      <ResizableSidebarLayout
        className="session-shell"
        storageKey="orchestra.layout.sessions.secondary-nav-width"
        navigationClassName="session-list-panel session-list-panel--desktop"
        detailClassName="session-detail-column"
        navigation={renderSessionNavigationPanel()}
        detail={(
        <>
          <SessionChatPanel
            session={selectedSession}
            referenceTasks={referenceTasks}
            referenceAgents={referenceAgents}
            referenceRoles={referenceRoles}
            displayedEvents={displayedEvents}
            sessionPending={selectedSessionPending}
            sessionDisplayStatus={selectedSessionDisplayStatus}
            selectedModelState={selectedModelState}
            selectedSessionStats={selectedSessionStats}
            sessionReadOnly={selectedSessionReadOnly}
            sessionMessageable={selectedSessionMessageable}
            loadingStatsSessionId={loadingStatsSessionId}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={draftMessage}
            piSetupState={piSetupState}
            transcriptRef={transcriptRef}
            scrollState={scrollState}
            wrapTranscript={wrapTranscript}
            onScrollLockChange={onScrollLockChange}
            onWrapTranscriptChange={setWrapTranscript}
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
            emptyStateEyebrow={selectedSessionPending ? "Opening session" : undefined}
            emptyStateTitle={selectedSessionPending ? "Loading exact session detail" : undefined}
            emptyStateDescription={selectedSessionPending
              ? "Waiting for the selected session record to hydrate so the requested session can open."
              : undefined}
            surface="page-mobile-detail"
          />

          {canShowDebugInfo && !showDebugInfo ? (
            <div className="session-detail-actions-row">
              <button
                type="button"
                className="session-debug-toggle"
                data-role="show-session-debug"
                onClick={() => setShowDebugInfo(true)}
              >
                Show debug information
              </button>
            </div>
          ) : null}

          {canShowDebugInfo && showDebugInfo && selectedSession?.debugInfo ? (
            <section className="panel session-debug-panel" data-role="session-debug-paths">
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">Debug paths</p>
                  <h4>Resolved runtime paths</h4>
                </div>
              </div>
              <div className="session-debug-grid">
                <section className="session-debug-item">
                  <p className="eyebrow">Project</p>
                  <p className="session-debug-value">{selectedSession.debugInfo.projectRoot ?? "—"}</p>
                </section>
                <section className="session-debug-item">
                  <p className="eyebrow">Managed repository</p>
                  <p className="session-debug-value">{selectedSession.debugInfo.managedRepositoryPath ?? "—"}</p>
                </section>
                <section className="session-debug-item">
                  <p className="eyebrow">Worktree</p>
                  <p className="session-debug-value">{selectedSession.debugInfo.worktreePath ?? "—"}</p>
                </section>
                <section className="session-debug-item">
                  <p className="eyebrow">Session cwd</p>
                  <p className="session-debug-value">{selectedSession.debugInfo.sessionCwd ?? "—"}</p>
                </section>
              </div>
            </section>
          ) : null}

        </>
        )}
      />

      {showCreateSessionFab ? (
        <div className="page-fab page-fab--sessions" data-role="sessions-create-fab">
          <button
            className="primary-button page-fab__button"
            data-role="create-session"
            type="button"
            disabled={createSessionDisabled}
            {...getTooltipProps("Start a new session in the active project.")}
            onClick={onCreateSession}
          >
            <span className="page-fab__icon" aria-hidden="true">+</span>
            <span className="page-fab__label">Create session</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
