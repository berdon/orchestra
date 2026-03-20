import { useEffect, useRef } from "react";

import type { SessionEvent, SessionRecord } from "../types";

interface SupervisorQuickChatModalProps {
  open: boolean;
  session: SessionRecord | null;
  events: SessionEvent[];
  draftMessage: string;
  pending: boolean;
  error: string | null;
  formatTimestamp: (timestamp: string) => string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
  onOpenFullSession: () => void;
}

export function SupervisorQuickChatModal({
  open,
  session,
  events,
  draftMessage,
  pending,
  error,
  formatTimestamp,
  onDraftChange,
  onSend,
  onClose,
  onOpenFullSession,
}: SupervisorQuickChatModalProps) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, session?.id]);

  useEffect(() => {
    if (!open || !transcriptRef.current) {
      return;
    }

    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [events, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="quick-chat-overlay" data-role="supervisor-quick-chat-overlay" onClick={onClose}>
      <section className="quick-chat-modal panel" data-role="supervisor-quick-chat" onClick={(event) => event.stopPropagation()}>
        <div className="panel__header panel__header--session-detail">
          <div>
            <p className="eyebrow">Supervisor quick chat</p>
            <h3>{session?.title ?? "Loading supervisor session…"}</h3>
            <p className="muted-copy">Persistent floating operator chat. Close and reopen without losing context.</p>
          </div>
          <div className="action-cluster">
            <button className="secondary-button" type="button" onClick={onOpenFullSession}>
              Open in Sessions
            </button>
            <button className="secondary-button" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {error ? <p className="error-copy">{error}</p> : null}

        <div className="quick-chat-transcript session-transcript" data-role="supervisor-transcript" ref={transcriptRef} role="log" aria-live="polite">
          {events.map((event) => (
            <article
              className={`transcript-event transcript-event--${event.kind}${event.pending ? " transcript-event--pending" : ""}`}
              key={event.id}
            >
              <div className="transcript-event__meta">
                <span>{event.kind}</span>
                <div className="transcript-event__meta-group">
                  {event.pending ? <span className="pending-badge">Pending</span> : null}
                  <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                </div>
              </div>
              <p>{event.message || (event.kind === "assistant" ? "…" : "Queued…")}</p>
            </article>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <label className="field-group field-group--composer">
            <span className="field-group__label">Message supervisor</span>
            <textarea
              ref={inputRef}
              className="text-area"
              data-role="supervisor-composer-input"
              rows={4}
              placeholder="Ask the supervisor to coordinate, review, or help steer the project…"
              value={draftMessage}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSend();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
          </label>
          <div className="composer__footer">
            <p className="muted-copy">Press Ctrl+Enter or ⌘+Enter to send. Ctrl+T reopens this chat any time.</p>
            <button className="primary-button" data-role="supervisor-send-message" type="submit" disabled={draftMessage.trim().length === 0}>
              Send
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
