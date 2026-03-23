import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import orchestraToolsExtension from "../extensions/orchestra-tools";

describe("orchestra tools extension bridge tool setup", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ORCHESTRA_BRIDGE_URL = "http://127.0.0.1:43123";
    process.env.ORCHESTRA_BRIDGE_TOKEN = "test-token";
    process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON = JSON.stringify([
      {
        name: "complete_lane_as_success",
        description: "Complete the current lane as success",
        requiredPermission: "tasks.transition",
      },
      {
        name: "get_task_context",
        description: "Read task context",
        requiredPermission: "tasks.read",
      },
      {
        name: "add_task_file_reference",
        description: "Track an important repo file on the task",
        requiredPermission: "tasks.update",
      },
      {
        name: "comment_on_task",
        description: "Add a durable task comment",
        requiredPermission: "tasks.comment",
      },
    ]);
    process.env.ORCHESTRA_AUTH_CONTEXT_JSON = JSON.stringify({ actorType: "user", actorId: "tester" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("registers one tool per allowed Orchestra command and routes execution to the matching bridge command", async () => {
    const registeredTools: Array<any> = [];
    const registeredCommands: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      async json() {
        return {
          success: true,
          data: {
            echoedCommand: JSON.parse(String(init?.body)).command,
            echoedPayload: JSON.parse(String(init?.body)).payload,
          },
        };
      },
    }));

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
    } as any);

    expect(registeredCommands).toEqual(expect.arrayContaining(["orchestra-tools", "orchestra-run"]));
    expect(registeredTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["orchestra_help", "complete_lane_as_success", "get_task_context", "add_task_file_reference", "comment_on_task"]),
    );
    expect(registeredTools.map((tool) => tool.name)).not.toContain("orchestra_command");

    const completionTool = registeredTools.find((tool) => tool.name === "complete_lane_as_success");
    const result = await completionTool.execute("tool-call-1", {
      inputJson: '{"taskId":"task-1","notes":"Ship it"}',
    });

    const repoFileTool = registeredTools.find((tool) => tool.name === "add_task_file_reference");
    const repoFileResult = await repoFileTool.execute("tool-call-2", {
      inputJson: '{"taskId":"task-1","input":{"repositoryId":"repo-1","relativePath":"docs/design.md"}}',
    });

    const commentTool = registeredTools.find((tool) => tool.name === "comment_on_task");
    const commentResult = await commentTool.execute("tool-call-3", {
      taskId: "task-1",
      author: "Worker",
      message: "Completed a large action because it was required.",
      interruptAgent: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.command).toBe("complete_lane_as_success");
    expect(request.payload).toEqual({ taskId: "task-1", notes: "Ship it" });
    const repoFileRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(repoFileRequest.command).toBe("add_task_file_reference");
    expect(repoFileRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        repositoryId: "repo-1",
        relativePath: "docs/design.md",
      },
    });
    const commentRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(commentRequest.command).toBe("comment_on_task");
    expect(commentRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        author: "Worker",
        message: "Completed a large action because it was required.",
        interruptAgent: false,
      },
    });
    expect(result.details.command).toBe("complete_lane_as_success");
    expect(result.content[0]?.text).toContain("complete_lane_as_success");
    expect(repoFileResult.details.command).toBe("add_task_file_reference");
    expect(repoFileResult.content[0]?.text).toContain("add_task_file_reference");
    expect(commentResult.details.command).toBe("comment_on_task");
    expect(commentResult.content[0]?.text).toContain("comment_on_task");
  });
});
