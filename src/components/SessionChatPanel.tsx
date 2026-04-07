import { memo, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type RefObject, type UIEvent } from "react";

import { TranscriptEventCard } from "./TranscriptEventCard";
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

function formatSessionStatusLabel(status: SessionStatus) {
  const label = status.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

interface SessionChatPanelProps {
  session: SessionRecord | null;
  title?: string | null;
  displayedEvents: SessionEvent[];
  sessionPending: boolean;
  sessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  sessionReadOnly?: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
  formatDateTime: (timestamp: string) => string;
  formatTimestamp: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  getStatusTone: (status: SessionStatus) => string;
  getEventTone: (kind: SessionEvent["kind"]) => string;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
  emptyStateEyebrow?: string;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
}

interface SessionComposerProps {
  session: SessionRecord;
  sessionPending: boolean;
  selectedModelState?: SessionModelState;
  sessionReadOnly: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  formatDateTime: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
}

const SessionComposer = memo(function SessionComposer({
  session,
  sessionPending,
  selectedModelState,
  sessionReadOnly,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  formatDateTime,
  formatModelOptionLabel,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
}: SessionComposerProps) {
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

  return (
    <>
      {sessionReadOnly ? (
        <div className="session-readonly-banner" data-role="session-terminal-readonly">
          This session is currently attached to an embedded terminal window. Close that window to resume chat here.
        </div>
      ) : null}

      <form className="composer" onSubmit={handleComposerSubmit}>
        <label className="field-group field-group--composer">
          <span className="field-group__label">Send</span>
          <textarea
            className="text-area"
            data-role="composer-input"
            rows={4}
            placeholder="Tell the session what to do next…"
            value={draftMessage}
            disabled={sessionReadOnly}
            onChange={handleDraftChange}
            onKeyDown={handleComposerKeyDown}
          />
        </label>
        <div className="composer__footer">
          <div className="composer__meta">
            <p className="muted-copy">
              {sessionReadOnly
                ? "This session is read-only while the embedded terminal window is attached."
                : sessionPending
                  ? "Response in progress…"
                  : "Press Ctrl+Enter or ⌘+Enter to send."}
            </p>
            <div className="session-detail__meta session-detail__meta--footer">
              <span>Created {formatDateTime(session.createdAt)}</span>
              <span>Updated {formatDateTime(session.updatedAt)}</span>
            </div>
          </div>
          <div className="composer__actions">
            <div className="session-model-field session-model-field--composer">
              <select
                className="select-input"
                aria-label="Session model"
                value={selectedModelState?.currentModel ? `${selectedModelState.currentModel.provider}/${selectedModelState.currentModel.id}` : ""}
                disabled={
                  sessionReadOnly ||
                  loadingModelSessionId === session.id ||
                  changingModelSessionId === session.id ||
                  sessionPending
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
              disabled={sessionReadOnly || !sessionPending}
              onClick={onStopSession}
            >
              Stop
            </button>
            <button
              className="primary-button"
              data-role="send-message"
              type="submit"
              disabled={sessionReadOnly || draftMessage.trim().length === 0}
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </>
  );
});

export function SessionChatPanel({
  session,
  title,
  displayedEvents,
  sessionPending,
  sessionDisplayStatus,
  selectedModelState,
  sessionReadOnly = false,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  transcriptRef,
  scrollState,
  formatDateTime,
  formatTimestamp,
  formatModelOptionLabel,
  getStatusTone,
  getEventTone,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
  emptyStateEyebrow = "No session selected",
  emptyStateTitle = "Create or select a session",
  emptyStateDescription = "Use the session list to select an existing session or create a new one to begin the interaction flow.",
}: SessionChatPanelProps) {
  const [wrapTranscript, setWrapTranscript] = useState(true);
  const [transcriptScrollMetrics, setTranscriptScrollMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });

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
  }, [displayedEvents, session?.id, transcriptRef, wrapTranscript]);

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nextLockedState = distanceFromBottom <= 24;

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
    <section
      className={sessionReadOnly ? "panel session-detail-panel session-chat-panel session-chat-panel--readonly" : "panel session-detail-panel session-chat-panel"}
      data-role="session-chat-panel"
      data-terminal-attached={sessionReadOnly ? "true" : "false"}
    >
      {session ? (
        <>
          <div className="panel__header panel__header--session-detail">
            <h3 data-role="selected-session-title">{title ?? session.title}</h3>

            <div className="action-cluster action-cluster--session-tools">
              <span className={`status-badge status-badge--${getStatusTone(sessionDisplayStatus)}`}>
                {formatSessionStatusLabel(sessionDisplayStatus)}
              </span>
              <span className={`status-badge status-badge--${getActivityTone(session.activityState)}`}>
                {formatActivityLabel(session.activityState, session.activeToolName)}
              </span>
              {sessionReadOnly ? <span className="status-badge status-badge--warning">Terminal attached</span> : null}
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
            {transcriptScrollIndicator.visible ? (
              <div
                className="session-transcript-scroll-indicator"
                aria-hidden="true"
                style={{
                  height: `${transcriptScrollIndicator.heightPercent}%`,
                  transform: `translateY(${transcriptScrollIndicator.offsetPercent}%)`,
                }}
              />
            ) : null}
          </div>

          <SessionComposer
            session={session}
            sessionPending={sessionPending}
            selectedModelState={selectedModelState}
            sessionReadOnly={sessionReadOnly}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={draftMessage}
            formatDateTime={formatDateTime}
            formatModelOptionLabel={formatModelOptionLabel}
            onModelChange={onModelChange}
            onDraftChange={onDraftChange}
            onSendMessage={onSendMessage}
            onStopSession={onStopSession}
          />
        </>
      ) : (
        <div className="empty-state">
          <p className="eyebrow">{emptyStateEyebrow}</p>
          <h3>{emptyStateTitle}</h3>
          <p>{emptyStateDescription}</p>
        </div>
      )}
    </section>
  );
}
