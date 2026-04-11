import { useEffect, useRef, useState, type RefObject } from "react";

import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SessionChatPanel } from "../components/SessionChatPanel";
import { getSessionListMetadata, getSessionListTitle } from "../lib/sessionList";
import type { SessionActivityState, SessionEvent, SessionModelState, SessionRecord, SessionScrollState, SessionStatus } from "../types";

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
  sessionFilter: "active" | "closed";
  onSessionFilterChange: (value: "active" | "closed") => void;
  selectedSession: SessionRecord | null;
  displayedEvents: SessionEvent[];
  selectedSessionPending: boolean;
  selectedSessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  selectedSessionReadOnly?: boolean;
  loadingSessions: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
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
  onCreateNewSession: () => void;
  onCompactSession: () => void;
}

export function SessionsPage({
  sessions,
  sessionFilter,
  onSessionFilterChange,
  selectedSession,
  displayedEvents,
  selectedSessionPending,
  selectedSessionDisplayStatus,
  selectedModelState,
  selectedSessionReadOnly = false,
  loadingSessions,
  loadingModelSessionId,
  changingModelSessionId,
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
  onCreateNewSession,
  onCompactSession,
}: SessionsPageProps) {
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [revealedDeleteSessionId, setRevealedDeleteSessionId] = useState<string | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const canShowDebugInfo = import.meta.env.DEV && Boolean(selectedSession?.debugInfo);

  useEffect(() => {
    setShowDebugInfo(false);
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

  return (
    <section className="panel-stack panel-stack--sessions">
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
                        <span className={`status-badge status-badge--${session.terminalAttached ? "warning" : getActivityTone(session.activityState)}`}>
                          {session.terminalAttached ? "Terminal attached" : formatActivityLabel(session.activityState, session.activeToolName)}
                        </span>
                      </div>
                      <span className="session-list-link__title">{getSessionListTitle(session)}</span>
                    </a>
                    <button
                      className="session-delete-button"
                      type="button"
                      tabIndex={showDeleteAction ? 0 : -1}
                      aria-label={`Dismiss ${getSessionListTitle(session)}`}
                      title="Dismiss from session list"
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
            displayedEvents={displayedEvents}
            sessionPending={selectedSessionPending}
            sessionDisplayStatus={selectedSessionDisplayStatus}
            selectedModelState={selectedModelState}
            sessionReadOnly={selectedSessionReadOnly}
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
            onCreateNewSession={onCreateNewSession}
            onCompactSession={onCompactSession}
          />

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
    </section>
  );
}
