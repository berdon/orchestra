import { describe, expect, it } from "vitest";

import { buildCollapsedPreview, buildThinkingPreview, detectTranscriptContent, isFoldableTranscriptEvent } from "../src/lib/sessionTranscript";

describe("session transcript helpers", () => {
  it("folds system events by default", () => {
    expect(isFoldableTranscriptEvent({ id: "event-1", kind: "system", message: "hello", timestamp: "2026-03-22T00:00:00Z" })).toBe(true);
    expect(isFoldableTranscriptEvent({ id: "event-2", kind: "assistant", message: "hello", timestamp: "2026-03-22T00:00:00Z" })).toBe(false);
  });

  it("builds a preview from the last three meaningful lines", () => {
    expect(buildCollapsedPreview("line 1\nline 2\nline 3\nline 4\nline 5")).toEqual({
      text: "…\nline 3\nline 4\nline 5",
      truncated: true,
    });
    expect(buildCollapsedPreview("### Tool\n\n```json\nline a\nline b\nline c\n```\n")).toEqual({
      text: "…\nline a\nline b\nline c",
      truncated: true,
    });
  });

  it("builds a stable three-line thinking preview for streaming updates", () => {
    expect(buildThinkingPreview("First line\nSecond line")).toEqual({
      text: "First line\nSecond line",
      truncated: false,
    });
    expect(buildThinkingPreview("First line\nSecond line\nThird line\nFourth line")).toEqual({
      text: "… Second line\nThird line\nFourth line",
      truncated: true,
    });
    expect(buildThinkingPreview("First line\nSecond line\nThird line\nFourth line\nFifth line\n")).toEqual({
      text: "… Third line\nFourth line\nFifth line",
      truncated: true,
    });
  });

  it("detects markdown and code-ish content", () => {
    expect(detectTranscriptContent("### Heading\n\n- item\n\n```ts\nconst x = 1;\n```\n").mode).toBe("markdown");
    expect(detectTranscriptContent('{"ok":true}')).toEqual({ mode: "code", language: "json" });
    expect(detectTranscriptContent("<div>Hello</div>")).toEqual({ mode: "code", language: "xml" });
  });
});
