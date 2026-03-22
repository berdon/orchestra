import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject, UIEvent } from "react";
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
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
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
  onModelChange,
  onDraftChange,
  onSendMessage,
}: SessionsPageProps) {
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
        </aside>

        <section className="panel session-detail-panel">
          {selectedSession ? (
            <>
              <div className="panel__header panel__header--session-detail">
                <h3 data-role="selected-session-title">{selectedSession.title}</h3>

                <div className="action-cluster action-cluster--session-tools">
                  <label className="field-group field-group--compact session-model-field">
                    <span className="field-group__label">Model</span>
                    <select
                      className="select-input"
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
                  </label>

                  <span className={`status-badge status-badge--${getStatusTone(selectedSessionDisplayStatus)}`}>{selectedSessionDisplayStatus}</span>
                  <span className="status-badge">{formatActivityLabel(selectedSession.activityState, selectedSession.activeToolName)}</span>
                </div>
              </div>

              <div className="session-transcript-wrap">
                <div
                  className="session-transcript"
                  data-role="session-transcript"
                  data-scroll-locked={scrollState.lockedToBottom ? "true" : "false"}
                  ref={transcriptRef}
                  role="log"
                  aria-live="polite"
                  onScroll={handleTranscriptScroll}
                >
                  {displayedEvents.map((event) => (
                    <article
                      className={`transcript-event transcript-event--${getEventTone(event.kind)}${event.pending ? " transcript-event--pending" : ""}`}
                      key={event.id}
                    >
                      <div className="transcript-event__meta">
                        <span>{event.kind}</span>
                        <div className="transcript-event__meta-group">
                          {event.thinking ? <span className="thinking-indicator">Thinking</span> : null}
                          {event.pending ? <span className="pending-badge">Pending</span> : null}
                          <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                        </div>
                      </div>
                      <p>{event.message || (event.kind === "assistant" ? (event.thinking ? "\u00a0" : "…") : "Queued…")}</p>
                    </article>
                  ))}
                </div>
                <div
                  className={scrollState.lockedToBottom ? "session-scroll-indicator session-scroll-indicator--locked" : "session-scroll-indicator"}
                  data-role="session-scroll-indicator"
                  data-scroll-locked={scrollState.lockedToBottom ? "true" : "false"}
                  role="status"
                  aria-live="polite"
                >
                  {scrollState.lockedToBottom ? "Auto-scroll on" : "Viewing older messages"}
                </div>
              </div>

              <form className="composer" onSubmit={handleComposerSubmit}>
                <label className="field-group field-group--composer">
                  <span className="field-group__label">Send message</span>
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
                  <button
                    className="primary-button"
                    data-role="send-message"
                    type="submit"
                    disabled={draftMessage.trim().length === 0}
                  >
                    Send message
                  </button>
                </div>
              </form>

              {selectedSession.debugInfo ? (
                <section className="task-section" data-role="session-debug-paths">
                  <div className="task-section__header">
                    <div>
                      <p className="eyebrow">Debug paths</p>
                      <h4>Resolved runtime paths</h4>
                    </div>
                  </div>
                  <div className="workforce-meta-grid muted-copy">
                    <span>Project: {selectedSession.debugInfo.projectRoot ?? "—"}</span>
                    <span>Managed repository: {selectedSession.debugInfo.managedRepositoryPath ?? "—"}</span>
                    <span>Worktree: {selectedSession.debugInfo.worktreePath ?? "—"}</span>
                    <span>Session cwd: {selectedSession.debugInfo.sessionCwd ?? "—"}</span>
                  </div>
                </section>
              ) : null}
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
  );
}
