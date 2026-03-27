import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type RefObject, type UIEvent } from "react";
import { TranscriptEventCard } from "../components/TranscriptEventCard";
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

interface SessionsPageProps {
  sessions: SessionRecord[];
  sessionFilter: "active" | "closed";
  onSessionFilterChange: (value: "active" | "closed") => void;
  selectedSession: SessionRecord | null;
  displayedEvents: SessionEvent[];
  selectedSessionPending: boolean;
  selectedSessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  loadingSessions: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  sessionActionError: string | null;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
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
  loadingSessions,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  sessionActionError,
  transcriptRef,
  scrollState,
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
}: SessionsPageProps) {
  const [wrapTranscript, setWrapTranscript] = useState(true);
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [transcriptScrollMetrics, setTranscriptScrollMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const canShowDebugInfo = import.meta.env.DEV && Boolean(selectedSession?.debugInfo);

  const transcriptScrollIndicator = useMemo(() => {
    const { scrollTop, scrollHeight, clientHeight } = transcriptScrollMetrics;
    if (scrollHeight <= clientHeight) {
      return { visible: false, heightPercent: 100, offsetPercent: 0 };
    }

    const heightPercent = Math.max((clientHeight / scrollHeight) * 100, 12);
    const maxOffset = Math.max(100 - heightPercent, 0);
    const scrollRange = Math.max(scrollHeight - clientHeight, 1);
    const offsetPercent = Math.min((scrollTop / scrollRange) * maxOffset, maxOffset);

    return { visible: true, heightPercent, offsetPercent };
  }, [transcriptScrollMetrics]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    setTranscriptScrollMetrics({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    });
  }, [displayedEvents, selectedSession?.id, transcriptRef, wrapTranscript]);

  useEffect(() => {
    setShowDebugInfo(false);
  }, [selectedSession?.id]);

  function handleComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSendMessage();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      onSendMessage();
    }
  }

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onDraftChange(event.target.value);
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const shouldLockToBottom = distanceFromBottom <= 24;
    const nextLockedState = shouldLockToBottom;

    setTranscriptScrollMetrics({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    });

    if (nextLockedState !== scrollState.lockedToBottom) {
      node.dispatchEvent(
        new CustomEvent("orchestra:session-scroll-lock-change", {
          bubbles: true,
          detail: { lockedToBottom: nextLockedState },
        }),
      );
    }
  }

  return (
    <section className="panel-stack panel-stack--sessions">
      <section className="session-shell">
        <aside className="session-list-panel">
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
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={session.id === selectedSession?.id ? "session-list-row session-list-row--active" : "session-list-row"}
                >
                  <a
                    data-role="session-link"
                    data-session-id={session.id}
                    className={session.id === selectedSession?.id ? "session-list-link session-list-link--active" : "session-list-link"}
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      onSelectSession(session.id);
                    }}
                  >
                    <span>{session.title}</span>
                    <span className="muted-copy">{formatActivityLabel(session.activityState, session.activeToolName)}</span>
                  </a>
                  <button
                    className="session-delete-button"
                    type="button"
                    aria-label={`Delete ${session.title}`}
                    onClick={() => onDeleteSession(session.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </nav>
          </div>

          {sessionFilter === "closed" ? (
            <div className="session-list-footer">
              <button className="secondary-button secondary-button--danger" data-role="delete-closed-sessions" type="button" onClick={onDeleteClosedSessions}>
                Delete closed
              </button>
            </div>
          ) : null}
        </aside>

        <div className="session-detail-column">
          <section className="panel session-detail-panel session-chat-panel" data-role="session-chat-panel">
            {selectedSession ? (
              <>
                <div className="panel__header panel__header--session-detail">
                  <h3 data-role="selected-session-title">{selectedSession.title}</h3>

                  <div className="action-cluster action-cluster--session-tools">
                    <span className={`status-badge status-badge--${getStatusTone(selectedSessionDisplayStatus)}`}>{selectedSessionDisplayStatus}</span>
                    <span className="status-badge">{formatActivityLabel(selectedSession.activityState, selectedSession.activeToolName)}</span>
                  </div>
                </div>

                <div className="session-transcript-wrap">
                  <button
                    type="button"
                    className="transcript-wrap-toggle transcript-wrap-toggle--floating"
                    data-role="session-wrap-toggle"
                    data-wrap-mode={wrapTranscript ? "wrap" : "nowrap"}
                    aria-pressed={wrapTranscript}
                    aria-label={wrapTranscript ? "Disable transcript line wrapping" : "Enable transcript line wrapping"}
                    title={wrapTranscript ? "Disable transcript line wrapping" : "Enable transcript line wrapping"}
                    onClick={() => setWrapTranscript((current) => !current)}
                  >
                    <span aria-hidden="true">{wrapTranscript ? "↩" : "↔"}</span>
                    <span>{wrapTranscript ? "Wrap" : "No wrap"}</span>
                  </button>
                  <div
                    className={wrapTranscript ? "session-transcript session-transcript--wrapped" : "session-transcript session-transcript--nowrap"}
                    data-role="session-transcript"
                    data-scroll-locked={scrollState.lockedToBottom ? "true" : "false"}
                    data-wrap-mode={wrapTranscript ? "wrap" : "nowrap"}
                    ref={transcriptRef}
                    role="log"
                    aria-live="polite"
                    onScroll={handleTranscriptScroll}
                  >
                    {displayedEvents.map((event) => (
                      <TranscriptEventCard
                        key={event.id}
                        event={event}
                        formatTimestamp={formatTimestamp}
                        tone={getEventTone(event.kind)}
                      />
                    ))}
                  </div>
                </div>

                <form className="composer" onSubmit={handleComposerSubmit}>
                  <label className="field-group field-group--composer">
                    <span className="field-group__label">Send</span>
                    <textarea
                      className="text-area"
                      data-role="composer-input"
                      rows={4}
                      placeholder="Tell the session what to do next…"
                      value={draftMessage}
                      onChange={handleDraftChange}
                      onKeyDown={handleComposerKeyDown}
                    />
                  </label>
                  <div className="composer__footer">
                    <div className="composer__meta">
                      <p className="muted-copy">
                        {selectedSessionPending ? "Response in progress…" : "Press Ctrl+Enter or ⌘+Enter to send."}
                      </p>
                      <div className="session-detail__meta session-detail__meta--footer">
                        <span>Created {formatDateTime(selectedSession.createdAt)}</span>
                        <span>Updated {formatDateTime(selectedSession.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="composer__actions">
                      <div className="session-model-field session-model-field--composer">
                        <select
                          className="select-input"
                          aria-label="Session model"
                          value={selectedModelState?.currentModel ? `${selectedModelState.currentModel.provider}/${selectedModelState.currentModel.id}` : ""}
                          disabled={
                            loadingModelSessionId === selectedSession.id ||
                            changingModelSessionId === selectedSession.id ||
                            selectedSessionPending
                          }
                          onChange={(event) => onModelChange(event.target.value)}
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
                      </div>
                      <button
                        className="secondary-button"
                        data-role="stop-session-runtime"
                        type="button"
                        disabled={!selectedSessionPending}
                        onClick={onStopSession}
                      >
                        Stop
                      </button>
                      <button
                        className="primary-button"
                        data-role="send-message"
                        type="submit"
                        disabled={draftMessage.trim().length === 0}
                      >
                        Send
                      </button>
                    </div>
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
        </div>
      </section>
    </section>
  );
}
