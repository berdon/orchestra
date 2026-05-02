import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SyntaxHighlightedMarkdownEditor, highlightMarkdownEditorText } from "../src/components/SyntaxHighlightedMarkdownEditor";

describe("SyntaxHighlightedMarkdownEditor", () => {
  test("renders a highlighted markdown layer behind the editable textarea", () => {
    const markup = renderToString(
      <SyntaxHighlightedMarkdownEditor
        id="notes-markdown-editor"
        dataRole="notes-markdown-editor"
        value={"# Heading\n\n- item"}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain('data-role="notes-markdown-editor"');
    expect(markup).toContain("notes-markdown-editor__highlight");
    expect(markup).toContain("hljs");
    expect(markup).toContain("language-markdown");
    expect(markup).toContain("hljs-section");
  });

  test("escapes raw html in the highlighted output", () => {
    const html = highlightMarkdownEditorText("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
    expect(html).toContain("script");
    expect(html).toContain("&gt;");
  });
});
