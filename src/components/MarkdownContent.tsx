import { Fragment, type ReactNode } from "react";
import hljs from "highlight.js";
import { marked } from "marked";

export interface MarkdownMentionMatch {
  key: string;
  label?: string;
  onClick: () => void;
}

export type MarkdownMentionResolver = (mention: string) => MarkdownMentionMatch | null;

interface MarkdownContentProps {
  message: string;
  className?: string;
  dataRole?: string;
  mentionLinkDataRole?: string;
  mentionResolver?: MarkdownMentionResolver;
}

const MENTION_PATTERN = /[@$](?:[a-z0-9._-]+:)?[a-z0-9._/-]+/gi;
const TRAILING_PUNCTUATION = /[),.!?;:]+$/;

type MarkdownToken = {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  title?: string | null;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  items?: Array<{ text?: string; tokens?: MarkdownToken[] }>;
  tokens?: MarkdownToken[];
};

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

function splitMentionToken(token: string) {
  const trailing = token.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  const mention = trailing ? token.slice(0, token.length - trailing.length) : token;
  return { mention, trailing };
}

function renderTextWithMentions(
  text: string,
  keyPrefix: string,
  mentionResolver?: MarkdownMentionResolver,
  mentionLinkDataRole?: string,
) {
  if (!mentionResolver) {
    return text;
  }

  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    const { mention, trailing } = splitMentionToken(token);
    const resolved = mentionResolver(mention);
    if (resolved) {
      parts.push(
        <button
          className="task-comment-message__mention-link"
          data-role={mentionLinkDataRole}
          data-mention-key={resolved.key}
          key={`${keyPrefix}-${resolved.key}-${index}`}
          type="button"
          onClick={resolved.onClick}
        >
          {resolved.label ?? mention}
        </button>,
      );
      if (trailing) {
        parts.push(trailing);
      }
    } else {
      parts.push(token);
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function renderInlineTokens(
  tokens: MarkdownToken[] | undefined,
  keyPrefix: string,
  mentionResolver?: MarkdownMentionResolver,
  mentionLinkDataRole?: string,
): ReactNode[] {
  if (!tokens?.length) {
    return [];
  }

  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (token.type) {
      case "text":
      case "escape":
        return <Fragment key={key}>{renderTextWithMentions(token.text ?? token.raw ?? "", key, mentionResolver, mentionLinkDataRole)}</Fragment>;
      case "codespan":
        return <code key={key}>{token.text ?? ""}</code>;
      case "strong":
        return <strong key={key}>{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</strong>;
      case "em":
        return <em key={key}>{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</em>;
      case "del":
        return <del key={key}>{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</del>;
      case "br":
        return <br key={key} />;
      case "link":
        return (
          <a key={key} href={token.href} rel="noreferrer" target="_blank">
            {renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}
          </a>
        );
      default:
        if (token.tokens?.length) {
          return <Fragment key={key}>{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</Fragment>;
        }
        return <Fragment key={key}>{renderTextWithMentions(token.raw ?? token.text ?? "", key, mentionResolver, mentionLinkDataRole)}</Fragment>;
    }
  });
}

function renderMarkdown(
  message: string,
  mentionResolver?: MarkdownMentionResolver,
  mentionLinkDataRole?: string,
) {
  const tokens = marked.lexer(message, { gfm: true, breaks: true }) as MarkdownToken[];

  return tokens.map((token, index) => {
    const key = `markdown-${index}`;

    switch (token.type) {
      case "heading": {
        const level = Math.min(Math.max(token.depth ?? 1, 1), 6);
        const content = renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole);
        switch (level) {
          case 1:
            return <h1 key={key} className="transcript-markdown-heading">{content}</h1>;
          case 2:
            return <h2 key={key} className="transcript-markdown-heading">{content}</h2>;
          case 3:
            return <h3 key={key} className="transcript-markdown-heading">{content}</h3>;
          case 4:
            return <h4 key={key} className="transcript-markdown-heading">{content}</h4>;
          case 5:
            return <h5 key={key} className="transcript-markdown-heading">{content}</h5>;
          default:
            return <h6 key={key} className="transcript-markdown-heading">{content}</h6>;
        }
      }
      case "paragraph":
        return <p key={key} className="transcript-event__paragraph">{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</p>;
      case "space":
        return null;
      case "hr":
        return <hr key={key} className="transcript-markdown-rule" />;
      case "blockquote":
        return <blockquote key={key} className="transcript-markdown-blockquote">{renderInlineTokens(token.tokens, key, mentionResolver, mentionLinkDataRole)}</blockquote>;
      case "list": {
        const ListTag = token.ordered ? "ol" : "ul";
        const listClassName = token.ordered
          ? "transcript-markdown-list transcript-markdown-list--ordered"
          : "transcript-markdown-list transcript-markdown-list--unordered";
        return (
          <ListTag key={key} className={listClassName}>
            {token.items?.map((item, itemIndex) => (
              <li key={`${key}-item-${itemIndex}`} value={token.ordered ? itemIndex + 1 : undefined}>
                {renderInlineTokens(item.tokens, `${key}-item-${itemIndex}`, mentionResolver, mentionLinkDataRole)}
              </li>
            ))}
          </ListTag>
        );
      }
      case "code": {
        const { html, detectedLanguage } = highlightText(token.text ?? "", token.lang || undefined);
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
        return <pre key={key} className="transcript-fallback-pre">{token.raw ?? token.text ?? ""}</pre>;
    }
  });
}

export function MarkdownContent({ message, className = "transcript-render transcript-render--markdown", dataRole, mentionLinkDataRole, mentionResolver }: MarkdownContentProps) {
  return (
    <div className={className} data-role={dataRole}>
      {renderMarkdown(message, mentionResolver, mentionLinkDataRole)}
    </div>
  );
}
