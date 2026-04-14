import { memo, useEffect, useMemo, useState } from "react";
import hljs from "highlight.js";

import { MarkdownContent, type MarkdownMentionResolver } from "./MarkdownContent";
import { buildCollapsedPreview, detectTranscriptContent, isFoldableTranscriptEvent, isToolCallTranscriptEvent } from "../lib/sessionTranscript";
import type { SessionEvent } from "../types";

interface TranscriptEventCardProps {
  event: SessionEvent;
  formatTimestamp: (timestamp: string) => string;
  tone: string;
  mentionResolver?: MarkdownMentionResolver;
  mentionLinkDataRole?: string;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightText(message: string, language?: string) {
  if (!message.trim()) {
    return { html: "&nbsp;", detectedLanguage: language ?? "text" };
  }

  try {
    if (language && hljs.getLanguage(language)) {
      return {
        html: hljs.highlight(message, { language, ignoreIllegals: true }).value,
        detectedLanguage: language,
      };
    }

    const result = hljs.highlightAuto(message);
    return {
      html: result.value,
      detectedLanguage: result.language ?? "text",
    };
  } catch {
    return {
      html: escapeHtml(message),
      detectedLanguage: language ?? "text",
    };
  }
}

function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

export const TranscriptEventCard = memo(function TranscriptEventCard({
  event,
  formatTimestamp,
  tone,
  mentionResolver,
  mentionLinkDataRole,
}: TranscriptEventCardProps) {
  const [expanded, setExpanded] = useState(() => !isFoldableTranscriptEvent(event));
  const [copied, setCopied] = useState(false);
  const thinkingPreview = (event.thinkingText ?? "").trim() || (event.kind === "assistant" && event.thinking ? "Thinking…" : "");
  const message = event.message || (event.kind === "assistant" ? (thinkingPreview ? "" : "…") : "Queued…");
  const foldable = isFoldableTranscriptEvent(event);
  const toolCall = isToolCallTranscriptEvent(event);
  const preview = useMemo(() => buildCollapsedPreview(message), [message]);
  const descriptor = useMemo(() => detectTranscriptContent(message), [message]);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function handleCopy() {
    await copyTextToClipboard(message);
    setCopied(true);
  }

  const articleClassName = `transcript-event transcript-event--${tone}${event.pending ? " transcript-event--pending" : ""}${foldable ? " transcript-event--foldable" : ""}${foldable && expanded ? " transcript-event--expanded" : " transcript-event--collapsed"}`;

  return (
    <article className={articleClassName} data-role="transcript-event" data-event-id={event.id} data-event-kind={event.kind} data-event-collapsed={foldable && !expanded ? "true" : "false"}>
      <div className="transcript-event__controls">
        {foldable ? (
          <button
            type="button"
            className="transcript-event__control-button"
            data-role="transcript-entry-toggle"
            data-event-id={event.id}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
        <button
          type="button"
          className="transcript-event__control-button"
          data-role="transcript-entry-copy"
          data-event-id={event.id}
          onClick={() => void handleCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="transcript-event__body">
        <div className="transcript-event__meta">
          <div className="transcript-event__meta-main">
            <span>{event.kind}</span>
            {event.thinking ? <span className="thinking-indicator">Thinking</span> : null}
            {event.pending ? <span className="pending-badge">Pending</span> : null}
          </div>
          {event.label ? <code className="transcript-event__label">{event.label}</code> : null}
        </div>
        {thinkingPreview ? (
          <div className="transcript-event__thinking-preview" data-role="transcript-thinking-preview">
            {thinkingPreview}
          </div>
        ) : null}
        {foldable && !expanded ? (
          toolCall ? <pre className="transcript-event__preview" data-role="transcript-entry-preview">{event.label ?? preview.text}</pre> : <pre className="transcript-event__preview" data-role="transcript-entry-preview">{preview.text}</pre>
        ) : message ? descriptor.mode === "code" ? (
          <SyntaxHighlightedBlock message={message} language={descriptor.language} />
        ) : (
          <MarkdownContent
            className="transcript-render transcript-render--markdown"
            dataRole="transcript-entry-rendered-markdown"
            mentionLinkDataRole={mentionLinkDataRole}
            mentionResolver={mentionResolver}
            message={message}
          />
        ) : null}
        <div className="transcript-event__footer">
          <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
        </div>
      </div>
    </article>
  );
});

function SyntaxHighlightedBlock({ message, language }: { message: string; language?: string }) {
  const { html, detectedLanguage } = useMemo(() => highlightText(message, language), [language, message]);

  return (
    <figure className="transcript-code-block" data-role="transcript-entry-code" data-language={detectedLanguage}>
      <figcaption>{detectedLanguage}</figcaption>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </figure>
  );
}
