import type { SessionEvent } from "../types";

export const TRANSCRIPT_PREVIEW_LINE_COUNT = 3;

export type TranscriptRenderMode = "plain" | "markdown" | "code";

export interface TranscriptContentDescriptor {
  mode: TranscriptRenderMode;
  language?: string;
}

const MARKDOWN_PATTERNS = [
  /^#{1,6}\s/m,
  /^>\s/m,
  /^[-*+]\s/m,
  /^\d+\.\s/m,
  /```/,
  /\|.+\|/,
  /\[[^\]]+\]\([^\)]+\)/,
];

const CODE_FENCE_PATTERN = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const SHELL_PATTERN = /(^|\n)(\$ |pnpm |npm |yarn |cargo |git |bash |sh )/;
const SQL_PATTERN = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;
const YAML_PATTERN = /^\s*[A-Za-z0-9_.-]+:\s+/m;
const JS_PATTERN = /\b(const|let|function|import|export|async|await|interface|type|class)\b/;

export function isFoldableTranscriptEvent(event: SessionEvent) {
  return event.kind === "system";
}

export function isToolCallTranscriptEvent(event: SessionEvent) {
  return event.presentation === "tool_call";
}

function trimPreviewLines(message: string) {
  const normalized = message.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = [...lines];

  while (previewLines.length > 0) {
    const candidate = previewLines[previewLines.length - 1]?.trim() ?? "";
    if (!candidate || candidate === "```") {
      previewLines.pop();
      continue;
    }
    break;
  }

  return { lines, previewLines };
}

export function buildCollapsedPreview(message: string, lineCount = TRANSCRIPT_PREVIEW_LINE_COUNT) {
  const { lines, previewLines } = trimPreviewLines(message);

  if (previewLines.length <= lineCount) {
    return {
      text: previewLines.join("\n"),
      truncated: previewLines.length < lines.length,
    };
  }

  return {
    text: ["…", ...previewLines.slice(-lineCount)].join("\n"),
    truncated: true,
  };
}

export function buildThinkingPreview(message: string, lineCount = TRANSCRIPT_PREVIEW_LINE_COUNT) {
  const { lines, previewLines } = trimPreviewLines(message);

  if (previewLines.length <= lineCount) {
    return {
      text: previewLines.join("\n"),
      truncated: previewLines.length < lines.length,
    };
  }

  const visibleLines = previewLines.slice(-lineCount);
  const [firstLine, ...rest] = visibleLines;
  return {
    text: [`… ${firstLine ?? ""}`.trimEnd(), ...rest].join("\n"),
    truncated: true,
  };
}

export function detectTranscriptContent(message: string): TranscriptContentDescriptor {
  const trimmed = message.trim();
  if (!trimmed) {
    return { mode: "plain" };
  }

  const fencedMatch = trimmed.match(CODE_FENCE_PATTERN);
  if (fencedMatch) {
    return {
      mode: "markdown",
      language: fencedMatch[1]?.trim() || undefined,
    };
  }

  if (MARKDOWN_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { mode: "markdown", language: "markdown" };
  }

  if (HTML_PATTERN.test(trimmed)) {
    return { mode: "code", language: "xml" };
  }

  if (SHELL_PATTERN.test(trimmed)) {
    return { mode: "code", language: "bash" };
  }

  if (SQL_PATTERN.test(trimmed)) {
    return { mode: "code", language: "sql" };
  }

  if (YAML_PATTERN.test(trimmed) && !trimmed.startsWith("{")) {
    return { mode: "code", language: "yaml" };
  }

  if (JS_PATTERN.test(trimmed)) {
    return { mode: "code", language: /\b(interface|type|implements|readonly)\b/.test(trimmed) ? "typescript" : "javascript" };
  }

  try {
    JSON.parse(trimmed);
    return { mode: "code", language: "json" };
  } catch {
    // fall through
  }

  if (trimmed.includes("\n")) {
    return { mode: "code" };
  }

  return { mode: "plain" };
}
