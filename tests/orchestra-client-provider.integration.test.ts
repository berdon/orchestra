import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OrchestraClientProvider,
  useOrchestraBootstrap,
} from "../src/lib/orchestraClient";
import { createMockOrchestraClientBinding } from "../src/lib/orchestraClient/mockClient";
import type { OrchestraClientServiceBindings } from "../src/lib/orchestraClient/serviceBindings";
import {
  useTaskCommentFileMentions,
  useTaskFileContent,
} from "../src/lib/orchestraData/tasks";

function createServices(overrides?: Partial<OrchestraClientServiceBindings>): OrchestraClientServiceBindings {
  return {
    app: {
      getInfo: vi.fn(async () => ({
        appName: "Orchestra",
        environment: "browser",
        backendStatus: "mock",
        versionDisplay: "0.1.0-test",
        dispatchBlocked: false,
        dispatchBlockedReason: null,
        piRuntimeDiagnostics: null,
      })),
      reportError: vi.fn(async () => "reported"),
      ...overrides?.app,
    },
    catalog: {
      listProjects: vi.fn(async () => []),
      getProject: vi.fn(async () => { throw new Error("unused"); }),
      listAgents: vi.fn(async () => []),
      listRoles: vi.fn(async () => []),
      listWorkflows: vi.fn(async () => []),
      getWorkflow: vi.fn(async () => { throw new Error("unused"); }),
      ...overrides?.catalog,
    },
    tasks: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => { throw new Error("unused"); }),
      create: vi.fn(async () => { throw new Error("unused"); }),
      update: vi.fn(async () => { throw new Error("unused"); }),
      remove: vi.fn(async () => { throw new Error("unused"); }),
      listTodos: vi.fn(async () => []),
      listUnfinishedTodos: vi.fn(async () => []),
      addTodo: vi.fn(async () => { throw new Error("unused"); }),
      markTodoFinished: vi.fn(async () => { throw new Error("unused"); }),
      markTodoUnfinished: vi.fn(async () => { throw new Error("unused"); }),
      deleteTodo: vi.fn(async () => { throw new Error("unused"); }),
      listComments: vi.fn(async () => []),
      comment: vi.fn(async () => { throw new Error("unused"); }),
      updateComment: vi.fn(async () => { throw new Error("unused"); }),
      deleteComment: vi.fn(async () => { throw new Error("unused"); }),
      markCommentsRead: vi.fn(async () => { throw new Error("unused"); }),
      searchCommentFileMentions: vi.fn(async () => []),
      listMessages: vi.fn(async () => []),
      addDependency: vi.fn(async () => { throw new Error("unused"); }),
      removeDependency: vi.fn(async () => { throw new Error("unused"); }),
      listFileReferences: vi.fn(async () => []),
      addFileReference: vi.fn(async () => { throw new Error("unused"); }),
      setDefaultFileReference: vi.fn(async () => { throw new Error("unused"); }),
      removeFileReference: vi.fn(async () => { throw new Error("unused"); }),
      getFileContent: vi.fn(async () => ""),
      addAttachment: vi.fn(async () => { throw new Error("unused"); }),
      removeAttachment: vi.fn(async () => { throw new Error("unused"); }),
      listSchedules: vi.fn(async () => []),
      getSchedule: vi.fn(async () => { throw new Error("unused"); }),
      createSchedule: vi.fn(async () => { throw new Error("unused"); }),
      updateSchedule: vi.fn(async () => { throw new Error("unused"); }),
      deleteSchedule: vi.fn(async () => { throw new Error("unused"); }),
      dispatch: vi.fn(async () => { throw new Error("unused"); }),
      complete: vi.fn(async () => { throw new Error("unused"); }),
      approveReview: vi.fn(async () => { throw new Error("unused"); }),
      approveCompletion: vi.fn(async () => { throw new Error("unused"); }),
      markNeedsWork: vi.fn(async () => { throw new Error("unused"); }),
      resume: vi.fn(async () => { throw new Error("unused"); }),
      pause: vi.fn(async () => { throw new Error("unused"); }),
      stopActivity: vi.fn(async () => { throw new Error("unused"); }),
      reassign: vi.fn(async () => { throw new Error("unused"); }),
      manualWhip: vi.fn(async () => { throw new Error("unused"); }),
      resetRuntime: vi.fn(async () => { throw new Error("unused"); }),
      ...overrides?.tasks,
    },
    inbox: {
      list: vi.fn(async () => []),
      send: vi.fn(async () => { throw new Error("unused"); }),
      markRead: vi.fn(async () => []),
      archive: vi.fn(async () => []),
      ...overrides?.inbox,
    },
    sessions: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => { throw new Error("unused"); }),
      getRuntimeDetails: vi.fn(async () => { throw new Error("unused"); }),
      getStats: vi.fn(async () => { throw new Error("unused"); }),
      create: vi.fn(async () => { throw new Error("unused"); }),
      createContextual: vi.fn(async () => { throw new Error("unused"); }),
      remove: vi.fn(async () => undefined),
      resume: vi.fn(async () => { throw new Error("unused"); }),
      subscribe: vi.fn(async () => { throw new Error("unused"); }),
      unsubscribe: vi.fn(async () => { throw new Error("unused"); }),
      stopRuntime: vi.fn(async () => { throw new Error("unused"); }),
      getModelState: vi.fn(async () => { throw new Error("unused"); }),
      setModel: vi.fn(async () => { throw new Error("unused"); }),
      compact: vi.fn(async () => { throw new Error("unused"); }),
      reload: vi.fn(async () => { throw new Error("unused"); }),
      sendMessage: vi.fn(async () => { throw new Error("unused"); }),
      ...overrides?.sessions,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orchestra client provider integration", () => {
  test("shared task hooks resolve file content through an injected mock OrchestraClient binding", async () => {
    const getFileContent = vi.fn(async (path: string) => `file:${path}`);
    const services = createServices({
      tasks: {
        getFileContent,
      },
    });
    const binding = createMockOrchestraClientBinding(services);
    let loadFile: ((path: string) => Promise<string | null>) | null = null;
    let capturedHostKind: string | null = null;

    function Probe() {
      loadFile = useTaskFileContent();
      capturedHostKind = useOrchestraBootstrap().hostKind;
      return React.createElement("div");
    }

    renderToString(
      React.createElement(
        OrchestraClientProvider,
        { binding },
        React.createElement(Probe),
      ),
    );

    expect(capturedHostKind).toBe("mock");
    await expect(loadFile?.("docs/design.md") ?? Promise.resolve(null)).resolves.toBe("file:docs/design.md");
    await expect(loadFile?.("") ?? Promise.resolve(null)).resolves.toBeNull();
    expect(getFileContent).toHaveBeenCalledTimes(1);
    expect(getFileContent).toHaveBeenCalledWith("docs/design.md");
  });

  test("shared task hooks resolve comment file mentions through an injected mock OrchestraClient binding", async () => {
    const searchCommentFileMentions = vi.fn(async (taskId: string, query: string, limit?: number) => [
      {
        path: "docs/design.md",
        lineNumber: 7,
        lineText: `Result for ${query}`,
        relativePath: "docs/design.md",
        displayText: "docs/design.md:7",
        insertText: "docs/design.md:7",
      },
    ]);
    const services = createServices({
      tasks: {
        searchCommentFileMentions,
      },
    });
    const binding = createMockOrchestraClientBinding(services);
    let lookupMentions: ((query: string, limit?: number) => Promise<unknown[]>) | null = null;

    function Probe() {
      lookupMentions = useTaskCommentFileMentions("task-123");
      return React.createElement("div");
    }

    renderToString(
      React.createElement(
        OrchestraClientProvider,
        { binding },
        React.createElement(Probe),
      ),
    );

    await expect(lookupMentions?.("design", 5) ?? Promise.resolve([])).resolves.toEqual([
      {
        path: "docs/design.md",
        lineNumber: 7,
        lineText: "Result for design",
        relativePath: "docs/design.md",
        displayText: "docs/design.md:7",
        insertText: "docs/design.md:7",
      },
    ]);
    expect(searchCommentFileMentions).toHaveBeenCalledWith("task-123", "design", 5);
  });
});
