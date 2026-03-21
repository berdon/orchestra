import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import orchestraToolsExtension from "../extensions/orchestra-tools";

describe("orchestra tools extension tool registration", () => {
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
      expect.arrayContaining(["orchestra_help", "complete_lane_as_success", "get_task_context", "comment_on_task"]),
    );
    expect(registeredTools.map((tool) => tool.name)).not.toContain("orchestra_command");

    const completionTool = registeredTools.find((tool) => tool.name === "complete_lane_as_success");
    const result = await completionTool.execute("tool-call-1", {
      inputJson: '{"taskId":"task-1","notes":"Ship it"}',
    });

    const commentTool = registeredTools.find((tool) => tool.name === "comment_on_task");
    const commentResult = await commentTool.execute("tool-call-2", {
      taskId: "task-1",
      author: "Worker",
      message: "Completed a large action because it was required.",
      interruptAgent: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.command).toBe("complete_lane_as_success");
    expect(request.payload).toEqual({ taskId: "task-1", notes: "Ship it" });
    const commentRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
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
    expect(commentResult.details.command).toBe("comment_on_task");
    expect(commentResult.content[0]?.text).toContain("comment_on_task");
  });
});
