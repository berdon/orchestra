// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/orchestraData/tasks", () => ({
  useTaskCommentFileMentions: () => async () => [],
}));

import { TaskDiffViewer } from "../src/components/TaskDiffViewer";
import type { TaskPullRequestFile } from "../src/types";

async function flushAnimationFrames(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }
}

describe("task PR line comment focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("focuses the inline composer on open, reopen, and line switches", async () => {
    const file: TaskPullRequestFile = {
      repositoryId: "repo-1",
      repositoryName: "Repo 1",
      repositorySlug: "repo-1",
      changeType: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      origin: "mixed",
      additions: 2,
      deletions: 1,
      isBinary: false,
      patch: [
        "diff --git a/src/example.ts b/src/example.ts",
        "@@ -1,2 +1,3 @@",
        " line one",
        "-line two",
        "+line two changed",
        "+line three",
      ].join("\n"),
    };

    await act(async () => {
      root.render(
        <TaskDiffViewer
          taskId="task-1"
          tasks={[]}
          agents={[]}
          roles={[]}
          file={file}
          fileReferences={[]}
          comments={[]}
          commentAuthor="Reviewer"
          onAddComment={vi.fn(async () => true)}
          onOpenFileReference={vi.fn()}
          onOpenTask={vi.fn()}
          onOpenAgent={vi.fn()}
          onOpenRole={vi.fn()}
        />,
      );
    });

    const oldLineButton = container.querySelector('button[aria-label="Add review comment on old line 2"]');
    expect(oldLineButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (oldLineButton as HTMLButtonElement).click();
      await flushAnimationFrames();
    });

    let messageField = container.querySelector('[data-role="task-pr-comment-message"]');
    expect(messageField).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(messageField);
    expect(container.textContent).toContain("Comment on old line 2");

    const cancelButton = container.querySelector('[data-role="cancel-task-pr-comment"]');
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (cancelButton as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-role="task-pr-comment-message"]')).toBeNull();

    await act(async () => {
      (oldLineButton as HTMLButtonElement).click();
      await flushAnimationFrames();
    });

    messageField = container.querySelector('[data-role="task-pr-comment-message"]');
    expect(messageField).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(messageField);

    const newLineButton = container.querySelector('button[aria-label="Add review comment on new line 3"]');
    expect(newLineButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (newLineButton as HTMLButtonElement).click();
      await flushAnimationFrames();
    });

    messageField = container.querySelector('[data-role="task-pr-comment-message"]');
    expect(messageField).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(messageField);
    expect(container.textContent).toContain("Comment on new line 3");
  });
});
