import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import hljs from "highlight.js";

interface SyntaxHighlightedMarkdownEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  spellCheck?: boolean;
  dataRole?: string;
  autoGrow?: boolean;
}

const MIN_EDITOR_HEIGHT_PX = 18 * 16;

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
  autoGrow = false,
}: SyntaxHighlightedMarkdownEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const highlightedHtml = useMemo(() => highlightMarkdownEditorText(value), [value]);

  const measureHeight = useCallback(() => {
    if (!autoGrow || !textareaRef.current) {
      return;
    }
    const textarea = textareaRef.current;
    const previousHeight = textarea.style.height;
    textarea.style.height = "0px";
    const nextHeight = Math.max(MIN_EDITOR_HEIGHT_PX, textarea.scrollHeight);
    textarea.style.height = previousHeight;
    setMeasuredHeight((current) => (current === nextHeight ? current : nextHeight));
  }, [autoGrow]);

  useLayoutEffect(() => {
    measureHeight();
  }, [measureHeight, value]);

  useEffect(() => {
    if (!autoGrow || typeof window === "undefined") {
      return;
    }

    const handleResize = () => measureHeight();
    window.addEventListener("resize", handleResize);

    const editor = editorRef.current;
    if (!editor || typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver(() => measureHeight());
    observer.observe(editor);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [autoGrow, measureHeight]);

  const handleScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  const editorStyle = autoGrow && measuredHeight
    ? { minHeight: `${measuredHeight}px`, height: `${measuredHeight}px` }
    : undefined;

  return (
    <div
      className={autoGrow ? "notes-markdown-editor notes-markdown-editor--auto-grow" : "notes-markdown-editor"}
      ref={editorRef}
      style={editorStyle}
    >
      <div className="notes-markdown-editor__highlight-shell transcript-code-block" aria-hidden="true">
        <pre className="notes-markdown-editor__highlight" ref={highlightRef}>
          <code className="hljs language-markdown" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        </pre>
      </div>
      <textarea
        id={id}
        className="notes-markdown-editor__textarea"
        data-role={dataRole}
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={handleScroll}
        readOnly={readOnly}
        spellCheck={spellCheck}
      />
    </div>
  );
}
