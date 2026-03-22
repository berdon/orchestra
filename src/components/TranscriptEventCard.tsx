import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js";
import { marked } from "marked";

import { buildCollapsedPreview, detectTranscriptContent, isFoldableTranscriptEvent, isToolCallTranscriptEvent } from "../lib/sessionTranscript";
import type { SessionEvent } from "../types";

interface TranscriptEventCardProps {
  event: SessionEvent;
  formatTimestamp: (timestamp: string) => string;
  tone: string;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
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

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return <span key={key}>{part}</span>;
  });
}

function renderMarkdown(message: string) {
  const tokens = marked.lexer(message, { gfm: true, breaks: true });

  return tokens.map((token, index) => {
    const key = `markdown-${index}`;

    switch (token.type) {
      case "heading": {
        const level = Math.min(Math.max(token.depth, 1), 6);
        switch (level) {
          case 1:
            return <h1 key={key} className="transcript-markdown-heading">{token.text}</h1>;
          case 2:
            return <h2 key={key} className="transcript-markdown-heading">{token.text}</h2>;
          case 3:
            return <h3 key={key} className="transcript-markdown-heading">{token.text}</h3>;
          case 4:
            return <h4 key={key} className="transcript-markdown-heading">{token.text}</h4>;
          case 5:
            return <h5 key={key} className="transcript-markdown-heading">{token.text}</h5>;
          default:
            return <h6 key={key} className="transcript-markdown-heading">{token.text}</h6>;
        }
      }
      case "paragraph":
        return <p key={key} className="transcript-event__paragraph">{renderInlineMarkdown(token.text, key)}</p>;
      case "space":
        return null;
      case "hr":
        return <hr key={key} className="transcript-markdown-rule" />;
      case "blockquote":
        return <blockquote key={key} className="transcript-markdown-blockquote">{token.text}</blockquote>;
      case "list": {
        const ListTag = token.ordered ? "ol" : "ul";
        return (
          <ListTag key={key} className="transcript-markdown-list">
            {token.items.map((item: { text: string }, itemIndex: number) => <li key={`${key}-item-${itemIndex}`}>{item.text}</li>)}
          </ListTag>
        );
      }
      case "code": {
        const { html, detectedLanguage } = highlightText(token.text, token.lang || undefined);
        return (
          <figure key={key} className="transcript-code-block" data-language={detectedLanguage}>
            <figcaption>{detectedLanguage}</figcaption>
            <pre>
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </figure>
        );
      }
      default:
        return <pre key={key} className="transcript-fallback-pre">{(token as { raw?: string }).raw ?? ""}</pre>;
    }
  });
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

export function TranscriptEventCard({ event, formatTimestamp, tone }: TranscriptEventCardProps) {
  const [expanded, setExpanded] = useState(() => !isFoldableTranscriptEvent(event));
  const [copied, setCopied] = useState(false);
  const message = event.message || (event.kind === "assistant" ? (event.thinking ? "\u00a0" : "…") : "Queued…");
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
        {foldable && !expanded ? (
          toolCall ? <pre className="transcript-event__preview" data-role="transcript-entry-preview">{event.label ?? preview.text}</pre> : <pre className="transcript-event__preview" data-role="transcript-entry-preview">{preview.text}</pre>
        ) : descriptor.mode === "markdown" ? (
          <div className="transcript-render transcript-render--markdown" data-role="transcript-entry-rendered-markdown">
            {renderMarkdown(message)}
          </div>
        ) : descriptor.mode === "code" ? (
          <SyntaxHighlightedBlock message={message} language={descriptor.language} />
        ) : (
          <p className="transcript-event__paragraph">{message}</p>
        )}
        <div className="transcript-event__footer">
          <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
        </div>
      </div>
    </article>
  );
}

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
