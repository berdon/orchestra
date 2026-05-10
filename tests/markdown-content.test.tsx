// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownContent } from "../src/components/MarkdownContent";

describe("MarkdownContent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders surrounding content plus ordered, unordered, and nested list items", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          dataRole="markdown-preview"
          message={[
            "# Markdown preview skill",
            "",
            "Intro paragraph before the list.",
            "",
            "- Unordered first",
            "- Unordered second",
            "  - Nested detail",
            "",
            "1. Ordered first",
            "2. Ordered second",
            "",
            "Trailing paragraph after the list.",
          ].join("\n")}
        />,
      );
    });

    const preview = container.querySelector('[data-role="markdown-preview"]');
    expect(preview).toBeTruthy();

    const heading = preview?.querySelector(':scope > h1');
    const paragraphs = Array.from(preview?.querySelectorAll(':scope > p') ?? []).map((node) => node.textContent?.trim() ?? "");
    const unorderedList = preview?.querySelector(':scope > ul');
    const unorderedItems = Array.from(unorderedList?.querySelectorAll(':scope > li') ?? []).map((node) => {
      const firstChild = node.firstChild;
      return firstChild?.textContent?.trim() ?? node.textContent?.trim() ?? "";
    });
    const nestedList = unorderedList?.querySelector(':scope > li ul');
    const nestedItems = Array.from(nestedList?.querySelectorAll(':scope > li') ?? []).map((node) => node.textContent?.trim() ?? "");
    const orderedList = preview?.querySelector(':scope > ol');
    const orderedItems = Array.from(orderedList?.querySelectorAll(':scope > li') ?? []).map((node) => node.textContent?.trim() ?? "");
    const secondOrderedItem = orderedList?.querySelectorAll(':scope > li')?.[1] ?? null;

    expect(heading?.textContent).toBe("Markdown preview skill");
    expect(paragraphs).toEqual([
      "Intro paragraph before the list.",
      "Trailing paragraph after the list.",
    ]);
    expect(unorderedItems).toEqual(["Unordered first", "Unordered second"]);
    expect(nestedItems).toEqual(["Nested detail"]);
    expect(orderedItems).toEqual(["Ordered first", "Ordered second"]);
    expect(secondOrderedItem?.getAttribute("value")).toBe("2");
  });
});
