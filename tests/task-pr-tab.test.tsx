import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskDiffViewer, parseUnifiedDiff } from "../src/components/TaskDiffViewer";
import { OrchestraClientProvider } from "../src/lib/orchestraClient";
import { createMockOrchestraClientBinding } from "../src/lib/orchestraClient/mockClient";
import { mockOrchestraClientServiceBindings } from "../src/lib/orchestraClient/mockBindings";
import { TaskPullRequestTab } from "../src/pages/tasks/TaskPullRequestTab";
import type { TaskComment, TaskDetail, TaskPullRequestFile } from "../src/types";

function createTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    projectId: "project-1",
    number: "ORC-259",
    title: "PR tab",
    description: "Test task",
    type: "feature",
    status: "in_progress",
    priority: "P2",
    workflowId: "workflow-1",
    currentLaneId: "lane-implementation",
    assigneeType: "role",
    assigneeId: "developer",
    archived: false,
    commentCount: 0,
    unreadCommentCount: 0,
    laneRunCount: 0,
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    blockedByCount: 0,
    blockingCount: 0,
    attachmentCount: 0,
    dependencyBlocked: false,
    readyForDispatch: false,
    tags: ["pr"],
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
    repositoryId: null,
    repositoryIds: [],
    parent: null,
    lineage: [],
    children: [],
    blockedBy: [],
    blocking: [],
    attachments: [],
    taskRepositories: [],
    fileReferences: [],
    comments: [],
    todos: [],
    laneRuns: [],
    activeLaneAssignment: null,
    ...overrides,
  };
}

function createComment(id: string, line: number, message: string): TaskComment {
  return {
    id,
    taskId: "task-1",
    parentCommentId: null,
    author: "Reviewer",
    originType: "user",
    originId: null,
    message,
    interruptAgent: false,
    repositoryId: "repo-1",
    relativePath: "src/example.ts",
    lineStart: line,
    lineEnd: line,
    columnStart: null,
    columnEnd: null,
    selectedText: null,
    anchorCommitHash: "head-1",
    anchorHasUncommittedChanges: true,
    diffAnchor: {
      kind: "task_pr",
      repositoryId: "repo-1",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      side: "new",
      oldLineStart: null,
      oldLineEnd: null,
      newLineStart: line,
      newLineEnd: line,
      baseCommitHash: "base-1",
      headCommitHash: "head-1",
    },
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  };
}

describe("task PR tab", () => {
  it("parses unified diffs into diff hunks", () => {
    const hunks = parseUnifiedDiff([
      "diff --git a/src/example.ts b/src/example.ts",
      "@@ -1,2 +1,3 @@",
      " line one",
      "-line two",
      "+line two changed",
      "+line three",
    ].join("\n"));

    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((line) => line.kind)).toEqual(["context", "del", "add", "add"]);
    expect(hunks[0].lines[1].oldLineNumber).toBe(2);
    expect(hunks[0].lines[2].newLineNumber).toBe(2);
  });

  it("renders the PR tab review shell", () => {
    const task = createTaskDetail({
      taskRepositories: [{ taskId: "task-1", repositoryId: "repo-1", repositoryName: "Repo 1", repositorySlug: "repo-1", managedRepositoryPath: "/tmp/repo-1", sourcePath: null, sourceKind: "local", taskWorktreePath: "/tmp/worktree-repo-1", createdAt: "2026-05-06T00:00:00Z" }],
    });
    const binding = createMockOrchestraClientBinding(mockOrchestraClientServiceBindings);
    const html = renderToString(
      <OrchestraClientProvider binding={binding}>
        <TaskPullRequestTab
          task={task}
          tasks={[]}
          agents={[]}
          roles={[]}
          commentAuthor="User"
          onAddComment={vi.fn(async () => true)}
          onOpenFileReference={vi.fn()}
          onOpenTask={vi.fn()}
          onOpenAgent={vi.fn()}
          onOpenRole={vi.fn()}
        />
      </OrchestraClientProvider>,
    );

    expect(html).toContain("Cross-repo review");
    expect(html).toContain("task-pr-summary");
    expect(html).toContain("task-pr-refresh");
  });

  it("renders diff review comments and outdated markers", () => {
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
    const html = renderToString(
      <TaskDiffViewer
        taskId="task-1"
        tasks={[]}
        agents={[]}
        roles={[]}
        file={file}
        fileReferences={[]}
        comments={[
          createComment("comment-current", 2, "Looks good"),
          createComment("comment-outdated", 99, "Outdated now"),
        ]}
        commentAuthor="User"
        onAddComment={vi.fn(async () => true)}
        onOpenFileReference={vi.fn()}
        onOpenTask={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenRole={vi.fn()}
      />,
    );

    expect(html).toContain("Looks good");
    expect(html).toContain("Outdated comments");
    expect(html).toContain("Outdated now");
    expect(html).toContain("task-pr-comment-line");
  });
});
