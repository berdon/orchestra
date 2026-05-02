import { useCallback, useMemo, useRef, type UIEvent } from "react";
import hljs from "highlight.js";

interface SyntaxHighlightedMarkdownEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  spellCheck?: boolean;
  dataRole?: string;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeEditorValue(value: string) {
  if (!value) {
    return " ";
  }
  return value.endsWith("\n") ? `${value} ` : value;
}

export function highlightMarkdownEditorText(value: string) {
  const normalized = normalizeEditorValue(value);

  try {
    if (hljs.getLanguage("markdown")) {
      return hljs.highlight(normalized, { language: "markdown", ignoreIllegals: true }).value || "&nbsp;";
    }
    const result = hljs.highlightAuto(normalized);
    return result.value || "&nbsp;";
  } catch {
    return escapeHtml(normalized).replace(/\n/g, "<br />");
  }
}

export function SyntaxHighlightedMarkdownEditor({
  id,
  value,
  onChange,
  readOnly = false,
  spellCheck = false,
  dataRole,
}: SyntaxHighlightedMarkdownEditorProps) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const highlightedHtml = useMemo(() => highlightMarkdownEditorText(value), [value]);

  const handleScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="notes-markdown-editor">
      <div className="notes-markdown-editor__highlight-shell transcript-code-block" aria-hidden="true">
        <pre className="notes-markdown-editor__highlight" ref={highlightRef}>
          <code className="hljs language-markdown" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        </pre>
      </div>
      <textarea
        id={id}
        className="notes-markdown-editor__textarea"
        data-role={dataRole}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={handleScroll}
        readOnly={readOnly}
        spellCheck={spellCheck}
      />
    </div>
  );
}
