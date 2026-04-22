import { useEffect, useRef, useState, type RefObject } from "react";

import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SessionChatPanel } from "../components/SessionChatPanel";
import { getSessionListMetadata, getSessionListTitle } from "../lib/sessionList";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { AgentSummary, RoleSummary, SessionActivityState, SessionEvent, SessionModelState, SessionRecord, SessionRuntimeDetails, SessionScrollState, SessionStats, SessionStatus, TaskSummary } from "../types";

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

function formatCapability(value?: { status: string; reason?: string | null } | null) {
  if (!value) {
    return "Unknown";
  }
  const status = value.status.charAt(0).toUpperCase() + value.status.slice(1);
  return value.reason ? `${status} · ${value.reason}` : status;
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
  loadingSessions: boolean;
  loadingStatsSessionId: string | null;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  loadingRuntimeDetailsSessionId: string | null;
  draftMessage: string;
  sessionActionError: string | null;
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
  onCompactSession: () => void;
  onReloadSession: () => void;
  onLoadRuntimeDetails: (sessionId: string) => Promise<SessionRuntimeDetails>;
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
  loadingSessions,
  loadingStatsSessionId,
  loadingModelSessionId,
  changingModelSessionId,
  loadingRuntimeDetailsSessionId,
  draftMessage,
  sessionActionError,
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
  onCompactSession,
  onReloadSession,
  onLoadRuntimeDetails,
}: SessionsPageProps) {
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [runtimeDetails, setRuntimeDetails] = useState<SessionRuntimeDetails | null>(null);
  const [runtimeDetailsError, setRuntimeDetailsError] = useState<string | null>(null);
  const [revealedDeleteSessionId, setRevealedDeleteSessionId] = useState<string | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const canShowDebugInfo = import.meta.env.DEV && Boolean(selectedSession?.debugInfo);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    setShowDebugInfo(false);
    setRuntimeDetails(null);
    setRuntimeDetailsError(null);
  }, [selectedSession?.id]);

  useEffect(() => () => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
    }
  }, []);

  function scheduleDeleteReveal(sessionId: string) {
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
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setRevealedDeleteSessionId(null);
  }

  async function handleOpenRuntimeDetails() {
    if (!selectedSession) {
      return;
    }
    setRuntimeDetailsError(null);
    try {
      setRuntimeDetails(await onLoadRuntimeDetails(selectedSession.id));
    } catch (error) {
      setRuntimeDetails(null);
      setRuntimeDetailsError(error instanceof Error ? error.message : "Unable to load session runtime details.");
    }
  }

  function handleCloseRuntimeDetails() {
    setRuntimeDetails(null);
    setRuntimeDetailsError(null);
  }

  return (
    <section className="panel-stack panel-stack--sessions panel-stack--sessions-layout">
      <ResizableSidebarLayout
        className="session-shell"
        storageKey="orchestra.layout.sessions.secondary-nav-width"
        navigationClassName="session-list-panel"
        detailClassName="session-detail-column"
        navigation={(
        <>
          {loadingSessions ? <p className="muted-copy">Loading sessions…</p> : null}
          {sessionActionError ? <p className="error-copy">{sessionActionError}</p> : null}

          <div className="filter-chip-row" role="tablist" aria-label="Session filters">
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

          <div className="session-list-scroll">
            <nav className="session-list" aria-label="Sessions">
              {sessions.length === 0 ? <p className="muted-copy">No {sessionFilter} sessions.</p> : null}
              {sessions.map((session) => {
                const isActive = session.id === selectedSession?.id;
                const showDeleteAction = revealedDeleteSessionId === session.id;
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

          {sessionFilter === "closed" ? (
            <div className="session-list-footer">
              <button className="secondary-button secondary-button--danger" data-role="delete-closed-sessions" type="button" onClick={onDeleteClosedSessions}>
                Dismiss closed
              </button>
            </div>
          ) : null}
        </>
        )}
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
            loadingStatsSessionId={loadingStatsSessionId}
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
            onReloadSession={onReloadSession}
            emptyStateEyebrow={selectedSessionPending ? "Opening session" : undefined}
            emptyStateTitle={selectedSessionPending ? "Loading exact session detail" : undefined}
            emptyStateDescription={selectedSessionPending
              ? "Waiting for the selected session record to hydrate so the requested session can open."
              : undefined}
          />

          {selectedSession ? (
            <div className="session-detail-actions-row">
              <button
                type="button"
                className="session-debug-toggle"
                data-role="open-session-runtime-details"
                onClick={() => void handleOpenRuntimeDetails()}
              >
                {loadingRuntimeDetailsSessionId === selectedSession.id ? "Loading runtime details…" : "Runtime details"}
              </button>
              {canShowDebugInfo && !showDebugInfo ? (
                <button
                  type="button"
                  className="session-debug-toggle"
                  data-role="show-session-debug"
                  onClick={() => setShowDebugInfo(true)}
                >
                  Show debug information
                </button>
              ) : null}
            </div>
          ) : null}

          {runtimeDetailsError ? <p className="error-copy">{runtimeDetailsError}</p> : null}

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

          {runtimeDetails ? (
            <div className="quick-chat-overlay" data-role="session-runtime-details-overlay" onClick={handleCloseRuntimeDetails}>
              <section className="quick-chat-modal panel session-runtime-details-dialog" data-role="session-runtime-details-dialog" onClick={(event) => event.stopPropagation()}>
                <div className="panel__header panel__header--stacked">
                  <div>
                    <p className="eyebrow">Session</p>
                    <h4>Runtime details</h4>
                    <p className="muted-copy">See the extension/runtime metadata Orchestra currently knows for this session.</p>
                  </div>
                  <div className="action-cluster action-cluster--wrap">
                    <button className="secondary-button" type="button" data-role="close-session-runtime-details" onClick={handleCloseRuntimeDetails}>
                      Close
                    </button>
                  </div>
                </div>

                <div className="session-debug-grid">
                  <section className="session-debug-item">
                    <p className="eyebrow">Runtime source</p>
                    <p className="session-debug-value">{runtimeDetails.source === "live_runtime" ? "Live runtime active" : "Expected next runtime spawn"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Extension load mode</p>
                    <p className="session-debug-value">{runtimeDetails.extensionLoadMode}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Automatic extensions/plugins</p>
                    <p className="session-debug-value">{runtimeDetails.automaticExtensionsDisabled ? "Disabled by --no-extensions" : "Enabled"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Subscribed</p>
                    <p className="session-debug-value">{runtimeDetails.subscribed ? "Yes" : "No"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Reload control</p>
                    <p className="session-debug-value">{formatCapability(runtimeDetails.controlCapabilities?.reload)}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Compact control</p>
                    <p className="session-debug-value">{formatCapability(runtimeDetails.controlCapabilities?.compact)}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Auto-compaction</p>
                    <p className="session-debug-value">{formatCapability(runtimeDetails.controlCapabilities?.autoCompact)}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Effective compaction window</p>
                    <p className="session-debug-value">{runtimeDetails.controlCapabilities?.effectiveCompactionWindow ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Compaction window source</p>
                    <p className="session-debug-value">{runtimeDetails.controlCapabilities?.effectiveCompactionWindowSource ?? "—"}</p>
                  </section>
                </div>

                <div className="session-runtime-details-grid">
                  <section className="session-debug-item" data-role="session-runtime-loaded-extensions">
                    <p className="eyebrow">Loaded extensions</p>
                    {runtimeDetails.loadedExtensions.length ? (
                      <ul className="session-runtime-details-list">
                        {runtimeDetails.loadedExtensions.map((extension) => (
                          <li className="session-debug-value" key={extension}>{extension}</li>
                        ))}
                      </ul>
                    ) : <p className="session-debug-value">—</p>}
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Extra configured extensions</p>
                    {runtimeDetails.extraExtensions.length ? (
                      <ul className="session-runtime-details-list">
                        {runtimeDetails.extraExtensions.map((extension) => (
                          <li className="session-debug-value" key={extension}>{extension}</li>
                        ))}
                      </ul>
                    ) : <p className="session-debug-value">None</p>}
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Blocked extra extensions</p>
                    {runtimeDetails.blockedExtraExtensions.length ? (
                      <ul className="session-runtime-details-list">
                        {runtimeDetails.blockedExtraExtensions.map((extension) => (
                          <li className="session-debug-value" key={extension}>{extension}</li>
                        ))}
                      </ul>
                    ) : <p className="session-debug-value">None</p>}
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">PI executable</p>
                    <p className="session-debug-value">{runtimeDetails.piExecutablePath ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">PI runtime source</p>
                    <p className="session-debug-value">{runtimeDetails.piRuntimeSource ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">PI agent dir</p>
                    <p className="session-debug-value">{runtimeDetails.piAgentDir ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Shell PATH source</p>
                    <p className="session-debug-value">{runtimeDetails.shellPath ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Project root</p>
                    <p className="session-debug-value">{runtimeDetails.projectRoot ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Session directory</p>
                    <p className="session-debug-value">{runtimeDetails.sessionDir ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Session file</p>
                    <p className="session-debug-value">{runtimeDetails.sessionPath ?? "—"}</p>
                  </section>
                  <section className="session-debug-item">
                    <p className="eyebrow">Orchestra extension</p>
                    <p className="session-debug-value">{runtimeDetails.orchestraExtensionPath ?? "—"}</p>
                  </section>
                </div>

                <section className="session-debug-item" data-role="session-runtime-notes">
                  <p className="eyebrow">Notes</p>
                  <ul className="session-runtime-details-list">
                    {runtimeDetails.notes.map((note) => (
                      <li className="session-debug-value" key={note}>{note}</li>
                    ))}
                  </ul>
                </section>
              </section>
            </div>
          ) : null}
        </>
        )}
      />
    </section>
  );
}
