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
      {
        name: "list_task_todos",
        description: "List task todos",
        requiredPermission: "tasks.read",
      },
      {
        name: "list_unfinished_task_todos",
        description: "List unfinished task todos",
        requiredPermission: "tasks.read",
      },
      {
        name: "add_task_todo",
        description: "Add a task todo",
        requiredPermission: "tasks.update",
      },
      {
        name: "mark_task_todo_finished",
        description: "Mark a task todo finished",
        requiredPermission: "tasks.update",
      },
      {
        name: "list_tasks",
        description: "List tasks for a project",
        requiredPermission: "tasks.read",
      },
      {
        name: "create_task",
        description: "Create a task in a project",
        requiredPermission: "tasks.create",
      },
      {
        name: "get_worker_overlay",
        description: "Get a worker overlay",
        requiredPermission: "projects.read",
      },
      {
        name: "update_worker_overlay",
        description: "Update a worker overlay",
        requiredPermission: "projects.update",
      },
      {
        name: "list_projects",
        description: "List Orchestra projects",
        requiredPermission: "projects.read",
      },
      {
        name: "get_project",
        description: "Get an Orchestra project",
        requiredPermission: "projects.read",
      },
      {
        name: "list_repositories",
        description: "List Orchestra repositories",
        requiredPermission: "projects.read",
      },
      {
        name: "get_repository",
        description: "Get an Orchestra repository",
        requiredPermission: "projects.read",
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
      expect.arrayContaining([
        "orchestra_help",
        "complete_lane_as_success",
        "get_task_context",
        "add_task_file_reference",
        "comment_on_task",
        "list_task_todos",
        "list_unfinished_task_todos",
        "add_task_todo",
        "mark_task_todo_finished",
        "list_tasks",
        "create_task",
        "get_worker_overlay",
        "update_worker_overlay",
        "list_projects",
        "get_project",
        "list_repositories",
        "get_repository",
      ]),
    );
    expect(registeredTools.map((tool) => tool.name)).not.toContain("orchestra_command");

    const completionTool = registeredTools.find((tool) => tool.name === "complete_lane_as_success");
    const result = await completionTool.execute("tool-call-1", {
      inputJson: '{"taskId":"task-1","notes":"Ship it"}',
    });

    const taskContextTool = registeredTools.find((tool) => tool.name === "get_task_context");
    expect(taskContextTool.parameters.properties.taskId).toBeTruthy();
    expect(taskContextTool.parameters.properties.inputJson).toBeUndefined();
    const taskContextResult = await taskContextTool.execute("tool-call-2", {
      taskId: "task-1",
    });

    const repoFileTool = registeredTools.find((tool) => tool.name === "add_task_file_reference");
    expect(repoFileTool.parameters.properties.taskId).toBeTruthy();
    expect(repoFileTool.parameters.properties.repositoryId).toBeTruthy();
    expect(repoFileTool.parameters.properties.relativePath).toBeTruthy();
    expect(repoFileTool.parameters.properties.inputJson).toBeUndefined();
    const repoFileResult = await repoFileTool.execute("tool-call-3", {
      taskId: "task-1",
      repositoryId: "repo-1",
      relativePath: "docs/design.md",
    });

    const commentTool = registeredTools.find((tool) => tool.name === "comment_on_task");
    const commentResult = await commentTool.execute("tool-call-4", {
      taskId: "task-1",
      author: "Worker",
      message: "Completed a large action because it was required.",
      interruptAgent: false,
    });

    const listTaskTodosTool = registeredTools.find((tool) => tool.name === "list_task_todos");
    expect(listTaskTodosTool.parameters.properties.taskId).toBeTruthy();
    const listTaskTodosResult = await listTaskTodosTool.execute("tool-call-5", {
      taskId: "task-1",
    });

    const listUnfinishedTodosTool = registeredTools.find((tool) => tool.name === "list_unfinished_task_todos");
    expect(listUnfinishedTodosTool.parameters.properties.taskId).toBeTruthy();
    expect(listUnfinishedTodosTool.parameters.properties.laneId).toBeTruthy();
    const listUnfinishedTodosResult = await listUnfinishedTodosTool.execute("tool-call-6", {
      taskId: "task-1",
      laneId: "lane-implement",
    });

    const addTaskTodoTool = registeredTools.find((tool) => tool.name === "add_task_todo");
    expect(addTaskTodoTool.parameters.properties.description).toBeTruthy();
    const addTaskTodoResult = await addTaskTodoTool.execute("tool-call-7", {
      taskId: "task-1",
      laneId: "lane-implement",
      description: "Write regression coverage",
    });

    const markTaskTodoFinishedTool = registeredTools.find((tool) => tool.name === "mark_task_todo_finished");
    expect(markTaskTodoFinishedTool.parameters.properties.todoId).toBeTruthy();
    const markTaskTodoFinishedResult = await markTaskTodoFinishedTool.execute("tool-call-8", {
      todoId: "todo-1",
    });

    const listProjectsTool = registeredTools.find((tool) => tool.name === "list_projects");
    expect(listProjectsTool.parameters.properties.inputJson).toBeUndefined();
    const listProjectsResult = await listProjectsTool.execute("tool-call-9", {});

    const getProjectTool = registeredTools.find((tool) => tool.name === "get_project");
    expect(getProjectTool.parameters.properties.projectId).toBeTruthy();
    const getProjectResult = await getProjectTool.execute("tool-call-10", {
      projectId: "project-1",
    });

    const listRepositoriesTool = registeredTools.find((tool) => tool.name === "list_repositories");
    expect(listRepositoriesTool.parameters.properties.projectId).toBeTruthy();
    const listRepositoriesResult = await listRepositoriesTool.execute("tool-call-11", {
      projectId: "project-1",
    });

    const getRepositoryTool = registeredTools.find((tool) => tool.name === "get_repository");
    expect(getRepositoryTool.parameters.properties.repositoryId).toBeTruthy();
    const getRepositoryResult = await getRepositoryTool.execute("tool-call-12", {
      repositoryId: "repo-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(12);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.command).toBe("complete_lane_as_success");
    expect(request.payload).toEqual({ taskId: "task-1", notes: "Ship it" });
    const taskContextRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(taskContextRequest.command).toBe("get_task_context");
    expect(taskContextRequest.payload).toEqual({ taskId: "task-1" });
    const repoFileRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(repoFileRequest.command).toBe("add_task_file_reference");
    expect(repoFileRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        repositoryId: "repo-1",
        relativePath: "docs/design.md",
      },
    });
    const commentRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(commentRequest.command).toBe("comment_on_task");
    expect(commentRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        author: "Worker",
        message: "Completed a large action because it was required.",
        interruptAgent: false,
        parentCommentId: null,
      },
    });
    const listTaskTodosRequest = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
    expect(listTaskTodosRequest.command).toBe("list_task_todos");
    expect(listTaskTodosRequest.payload).toEqual({ taskId: "task-1" });
    const listUnfinishedTodosRequest = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body));
    expect(listUnfinishedTodosRequest.command).toBe("list_unfinished_task_todos");
    expect(listUnfinishedTodosRequest.payload).toEqual({ taskId: "task-1", laneId: "lane-implement" });
    const addTaskTodoRequest = JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body));
    expect(addTaskTodoRequest.command).toBe("add_task_todo");
    expect(addTaskTodoRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        laneId: "lane-implement",
        description: "Write regression coverage",
      },
    });
    const markTaskTodoFinishedRequest = JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body));
    expect(markTaskTodoFinishedRequest.command).toBe("mark_task_todo_finished");
    expect(markTaskTodoFinishedRequest.payload).toEqual({ todoId: "todo-1" });
    const listProjectsRequest = JSON.parse(String(fetchMock.mock.calls[8]?.[1]?.body));
    expect(listProjectsRequest.command).toBe("list_projects");
    expect(listProjectsRequest.payload).toEqual({});
    const getProjectRequest = JSON.parse(String(fetchMock.mock.calls[9]?.[1]?.body));
    expect(getProjectRequest.command).toBe("get_project");
    expect(getProjectRequest.payload).toEqual({ projectId: "project-1" });
    const listRepositoriesRequest = JSON.parse(String(fetchMock.mock.calls[10]?.[1]?.body));
    expect(listRepositoriesRequest.command).toBe("list_repositories");
    expect(listRepositoriesRequest.payload).toEqual({ projectId: "project-1" });
    const getRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[11]?.[1]?.body));
    expect(getRepositoryRequest.command).toBe("get_repository");
    expect(getRepositoryRequest.payload).toEqual({ repositoryId: "repo-1" });
    expect(result.details.command).toBe("complete_lane_as_success");
    expect(result.content[0]?.text).toContain("complete_lane_as_success");
    expect(taskContextResult.details.command).toBe("get_task_context");
    expect(taskContextResult.content[0]?.text).toContain("get_task_context");
    expect(repoFileResult.details.command).toBe("add_task_file_reference");
    expect(repoFileResult.content[0]?.text).toContain("add_task_file_reference");
    expect(commentResult.details.command).toBe("comment_on_task");
    expect(commentResult.content[0]?.text).toContain("comment_on_task");
    expect(listTaskTodosResult.details.command).toBe("list_task_todos");
    expect(listTaskTodosResult.content[0]?.text).toContain("list_task_todos");
    expect(listUnfinishedTodosResult.details.command).toBe("list_unfinished_task_todos");
    expect(listUnfinishedTodosResult.content[0]?.text).toContain("list_unfinished_task_todos");
    expect(addTaskTodoResult.details.command).toBe("add_task_todo");
    expect(addTaskTodoResult.content[0]?.text).toContain("add_task_todo");
    expect(markTaskTodoFinishedResult.details.command).toBe("mark_task_todo_finished");
    expect(markTaskTodoFinishedResult.content[0]?.text).toContain("mark_task_todo_finished");
    expect(listProjectsResult.details.command).toBe("list_projects");
    expect(listProjectsResult.content[0]?.text).toContain("list_projects");
    expect(getProjectResult.details.command).toBe("get_project");
    expect(getProjectResult.content[0]?.text).toContain("get_project");
    expect(listRepositoriesResult.details.command).toBe("list_repositories");
    expect(listRepositoriesResult.content[0]?.text).toContain("list_repositories");
    expect(getRepositoryResult.details.command).toBe("get_repository");
    expect(getRepositoryResult.content[0]?.text).toContain("get_repository");
  });

  test("exposes project-scoped tool parameters and detailed help", async () => {
    const registeredTools: Array<any> = [];
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
      registerCommand() {},
    } as any);

    const createTaskTool = registeredTools.find((tool) => tool.name === "create_task");
    expect(createTaskTool.parameters.properties.projectId).toBeTruthy();
    expect(createTaskTool.parameters.properties.title).toBeTruthy();
    expect(createTaskTool.parameters.properties.inputJson).toBeUndefined();
    await createTaskTool.execute("tool-call-1", {
      projectId: "project-2",
      title: "Scoped task",
      description: "Create it in the right place",
      type: "bug",
      priority: "P1",
    });

    const listTasksTool = registeredTools.find((tool) => tool.name === "list_tasks");
    expect(listTasksTool.parameters.properties.projectId).toBeTruthy();
    await listTasksTool.execute("tool-call-2", {
      projectId: "project-2",
      includeArchived: false,
    });

    const getWorkerOverlayTool = registeredTools.find((tool) => tool.name === "get_worker_overlay");
    expect(getWorkerOverlayTool.parameters.properties.projectSlug).toBeTruthy();
    await getWorkerOverlayTool.execute("tool-call-3", {
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
    });

    const updateWorkerOverlayTool = registeredTools.find((tool) => tool.name === "update_worker_overlay");
    expect(updateWorkerOverlayTool.parameters.properties.projectSlug).toBeTruthy();
    await updateWorkerOverlayTool.execute("tool-call-4", {
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
      prompt: "Use the scoped overlay",
    });

    const helpTool = registeredTools.find((tool) => tool.name === "orchestra_help");
    expect(helpTool.parameters.properties.command).toBeTruthy();
    const helpResult = await helpTool.execute("tool-call-5", { command: "create_task" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      projectId: "project-2",
      input: {
        title: "Scoped task",
        description: "Create it in the right place",
        type: "bug",
        status: "ready",
        priority: "P1",
        assigneeType: "unassigned",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      projectId: "project-2",
      includeArchived: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).payload).toEqual({
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).payload).toEqual({
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
      prompt: "Use the scoped overlay",
    });
    expect(helpResult.details.requestedCommand).toBe("create_task");
    expect(helpResult.content[0]?.text).toContain('"command": "create_task"');
    expect(helpResult.content[0]?.text).toContain('"projectId"');
    expect(helpResult.content[0]?.text).toContain('"title"');
  });
});
