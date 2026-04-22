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
        name: "reassign_task_to_lane",
        description: "Move a task into a specific workflow lane",
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
        name: "update_task",
        description: "Update an existing task",
        requiredPermission: "tasks.update",
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
        name: "create_project",
        description: "Create an Orchestra project",
        requiredPermission: "projects.create",
      },
      {
        name: "update_project",
        description: "Update an Orchestra project",
        requiredPermission: "projects.update",
      },
      {
        name: "delete_project",
        description: "Delete an Orchestra project",
        requiredPermission: "projects.delete",
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
      {
        name: "create_repository",
        description: "Create an Orchestra repository",
        requiredPermission: "repositories.write",
      },
      {
        name: "update_repository",
        description: "Update an Orchestra repository",
        requiredPermission: "repositories.write",
      },
      {
        name: "delete_repository",
        description: "Delete an Orchestra repository",
        requiredPermission: "repositories.write",
      },
      {
        name: "attach_repository_remote",
        description: "Attach a repository remote",
        requiredPermission: "repositories.write",
      },
      {
        name: "set_project_default_repository",
        description: "Set the default repository for a project",
        requiredPermission: "projects.update",
      },
      {
        name: "list_workflows",
        description: "List workflows",
        requiredPermission: "workflows.read",
      },
      {
        name: "get_workflow",
        description: "Get a workflow",
        requiredPermission: "workflows.read",
      },
      {
        name: "validate_workflow",
        description: "Validate a workflow definition",
        requiredPermission: "workflows.read",
      },
      {
        name: "create_workflow",
        description: "Create a workflow",
        requiredPermission: "workflows.create",
      },
      {
        name: "update_workflow",
        description: "Update a workflow",
        requiredPermission: "workflows.update",
      },
      {
        name: "add_workflow_lane",
        description: "Add a lane to a workflow",
        requiredPermission: "workflows.update",
      },
      {
        name: "update_workflow_lane",
        description: "Update a workflow lane",
        requiredPermission: "workflows.update",
      },
      {
        name: "delete_workflow_lane",
        description: "Delete a workflow lane",
        requiredPermission: "workflows.update",
      },
      {
        name: "reorder_workflow_lanes",
        description: "Reorder workflow lanes",
        requiredPermission: "workflows.update",
      },
      {
        name: "duplicate_workflow",
        description: "Duplicate a workflow",
        requiredPermission: "workflows.create",
      },
      {
        name: "archive_workflow",
        description: "Archive a workflow",
        requiredPermission: "workflows.archive",
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
        "reassign_task_to_lane",
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
        "create_project",
        "update_project",
        "delete_project",
        "list_repositories",
        "get_repository",
        "create_repository",
        "update_repository",
        "delete_repository",
        "attach_repository_remote",
        "set_project_default_repository",
        "list_workflows",
        "get_workflow",
        "validate_workflow",
        "create_workflow",
        "update_workflow",
        "add_workflow_lane",
        "update_workflow_lane",
        "delete_workflow_lane",
        "reorder_workflow_lanes",
        "duplicate_workflow",
        "archive_workflow",
      ]),
    );
    expect(registeredTools.map((tool) => tool.name)).not.toContain("orchestra_command");

    const completionTool = registeredTools.find((tool) => tool.name === "complete_lane_as_success");
    const result = await completionTool.execute("tool-call-1", {
      inputJson: '{"taskId":"task-1","notes":"Ship it"}',
    });

    const relaneTool = registeredTools.find((tool) => tool.name === "reassign_task_to_lane");
    expect(relaneTool.parameters.properties.taskId).toBeTruthy();
    expect(relaneTool.parameters.properties.laneId).toBeTruthy();
    const relaneResult = await relaneTool.execute("tool-call-2", {
      taskId: "task-1",
      laneId: "lane-plan",
      notes: "Return this task to planning",
    });

    const taskContextTool = registeredTools.find((tool) => tool.name === "get_task_context");
    expect(taskContextTool.parameters.properties.taskId).toBeTruthy();
    expect(taskContextTool.parameters.properties.inputJson).toBeUndefined();
    const taskContextResult = await taskContextTool.execute("tool-call-3", {
      taskId: "task-1",
    });

    const repoFileTool = registeredTools.find((tool) => tool.name === "add_task_file_reference");
    expect(repoFileTool.parameters.properties.taskId).toBeTruthy();
    expect(repoFileTool.parameters.properties.repositoryId).toBeTruthy();
    expect(repoFileTool.parameters.properties.relativePath).toBeTruthy();
    expect(repoFileTool.parameters.properties.inputJson).toBeUndefined();
    const repoFileResult = await repoFileTool.execute("tool-call-4", {
      taskId: "task-1",
      repositoryId: "repo-1",
      relativePath: "docs/design.md",
    });

    const commentTool = registeredTools.find((tool) => tool.name === "comment_on_task");
    const commentResult = await commentTool.execute("tool-call-5", {
      taskId: "task-1",
      author: "Worker",
      message: "Completed a large action because it was required.",
      interruptAgent: false,
    });

    const listTaskTodosTool = registeredTools.find((tool) => tool.name === "list_task_todos");
    expect(listTaskTodosTool.parameters.properties.taskId).toBeTruthy();
    const listTaskTodosResult = await listTaskTodosTool.execute("tool-call-6", {
      taskId: "task-1",
    });

    const listUnfinishedTodosTool = registeredTools.find((tool) => tool.name === "list_unfinished_task_todos");
    expect(listUnfinishedTodosTool.parameters.properties.taskId).toBeTruthy();
    expect(listUnfinishedTodosTool.parameters.properties.laneId).toBeTruthy();
    const listUnfinishedTodosResult = await listUnfinishedTodosTool.execute("tool-call-7", {
      taskId: "task-1",
      laneId: "lane-implement",
    });

    const addTaskTodoTool = registeredTools.find((tool) => tool.name === "add_task_todo");
    expect(addTaskTodoTool.parameters.properties.description).toBeTruthy();
    expect(addTaskTodoTool.parameters.properties.laneId).toBeTruthy();
    expect(addTaskTodoTool.parameters.required).toContain("laneId");
    const addTaskTodoResult = await addTaskTodoTool.execute("tool-call-8", {
      taskId: "task-1",
      laneId: "lane-implement",
      description: "Write regression coverage",
    });

    const markTaskTodoFinishedTool = registeredTools.find((tool) => tool.name === "mark_task_todo_finished");
    expect(markTaskTodoFinishedTool.parameters.properties.todoId).toBeTruthy();
    const markTaskTodoFinishedResult = await markTaskTodoFinishedTool.execute("tool-call-9", {
      todoId: "todo-1",
    });

    const listProjectsTool = registeredTools.find((tool) => tool.name === "list_projects");
    expect(listProjectsTool.parameters.properties.inputJson).toBeUndefined();
    const listProjectsResult = await listProjectsTool.execute("tool-call-10", {});

    const getProjectTool = registeredTools.find((tool) => tool.name === "get_project");
    expect(getProjectTool.parameters.properties.projectId).toBeTruthy();
    const getProjectResult = await getProjectTool.execute("tool-call-11", {
      projectId: "project-1",
    });

    const createProjectTool = registeredTools.find((tool) => tool.name === "create_project");
    expect(createProjectTool.parameters.properties.name).toBeTruthy();
    const createProjectResult = await createProjectTool.execute("tool-call-12", {
      name: "Bridge project",
      description: "Created through the bridge tool",
    });

    const updateProjectTool = registeredTools.find((tool) => tool.name === "update_project");
    expect(updateProjectTool.parameters.properties.projectId).toBeTruthy();
    const updateProjectResult = await updateProjectTool.execute("tool-call-13", {
      projectId: "project-1",
      name: "Updated bridge project",
      description: "Updated through the bridge tool",
    });

    const deleteProjectTool = registeredTools.find((tool) => tool.name === "delete_project");
    expect(deleteProjectTool.parameters.properties.projectId).toBeTruthy();
    const deleteProjectResult = await deleteProjectTool.execute("tool-call-14", {
      projectId: "project-2",
    });

    const listRepositoriesTool = registeredTools.find((tool) => tool.name === "list_repositories");
    expect(listRepositoriesTool.parameters.properties.projectId).toBeTruthy();
    const listRepositoriesResult = await listRepositoriesTool.execute("tool-call-15", {
      projectId: "project-1",
    });

    const getRepositoryTool = registeredTools.find((tool) => tool.name === "get_repository");
    expect(getRepositoryTool.parameters.properties.repositoryId).toBeTruthy();
    const getRepositoryResult = await getRepositoryTool.execute("tool-call-16", {
      repositoryId: "repo-1",
    });

    const createRepositoryTool = registeredTools.find((tool) => tool.name === "create_repository");
    expect(createRepositoryTool.parameters.properties.projectId).toBeTruthy();
    const createRepositoryResult = await createRepositoryTool.execute("tool-call-17", {
      projectId: "project-1",
      name: "New repo",
      mode: "existing",
      repositoryPath: "/tmp/new-repo",
      defaultBranch: "main",
    });

    const updateRepositoryTool = registeredTools.find((tool) => tool.name === "update_repository");
    expect(updateRepositoryTool.parameters.properties.repositoryId).toBeTruthy();
    const updateRepositoryResult = await updateRepositoryTool.execute("tool-call-18", {
      repositoryId: "repo-1",
      name: "Updated repo",
      mode: "existing",
      repositoryPath: "/tmp/updated-repo",
      defaultBranch: "develop",
    });

    const deleteRepositoryTool = registeredTools.find((tool) => tool.name === "delete_repository");
    expect(deleteRepositoryTool.parameters.properties.repositoryId).toBeTruthy();
    const deleteRepositoryResult = await deleteRepositoryTool.execute("tool-call-19", {
      repositoryId: "repo-2",
    });

    const attachRepositoryRemoteTool = registeredTools.find((tool) => tool.name === "attach_repository_remote");
    expect(attachRepositoryRemoteTool.parameters.properties.remoteUrl).toBeTruthy();
    const attachRepositoryRemoteResult = await attachRepositoryRemoteTool.execute("tool-call-20", {
      repositoryId: "repo-1",
      remoteUrl: "git@example.com:org/repo.git",
      remoteName: "origin",
    });

    const setProjectDefaultRepositoryTool = registeredTools.find((tool) => tool.name === "set_project_default_repository");
    expect(setProjectDefaultRepositoryTool.parameters.properties.projectId).toBeTruthy();
    const setProjectDefaultRepositoryResult = await setProjectDefaultRepositoryTool.execute("tool-call-21", {
      projectId: "project-1",
      repositoryId: "repo-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(21);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.command).toBe("complete_lane_as_success");
    expect(request.payload).toEqual({ taskId: "task-1", notes: "Ship it" });
    const relaneRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(relaneRequest.command).toBe("reassign_task_to_lane");
    expect(relaneRequest.payload).toEqual({
      taskId: "task-1",
      laneId: "lane-plan",
      notes: "Return this task to planning",
    });
    const taskContextRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(taskContextRequest.command).toBe("get_task_context");
    expect(taskContextRequest.payload).toEqual({ taskId: "task-1" });
    const repoFileRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(repoFileRequest.command).toBe("add_task_file_reference");
    expect(repoFileRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        repositoryId: "repo-1",
        relativePath: "docs/design.md",
      },
    });
    const commentRequest = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
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
    const listTaskTodosRequest = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body));
    expect(listTaskTodosRequest.command).toBe("list_task_todos");
    expect(listTaskTodosRequest.payload).toEqual({ taskId: "task-1" });
    const listUnfinishedTodosRequest = JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body));
    expect(listUnfinishedTodosRequest.command).toBe("list_unfinished_task_todos");
    expect(listUnfinishedTodosRequest.payload).toEqual({ taskId: "task-1", laneId: "lane-implement" });
    const addTaskTodoRequest = JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body));
    expect(addTaskTodoRequest.command).toBe("add_task_todo");
    expect(addTaskTodoRequest.payload).toEqual({
      taskId: "task-1",
      input: {
        laneId: "lane-implement",
        description: "Write regression coverage",
      },
    });
    const markTaskTodoFinishedRequest = JSON.parse(String(fetchMock.mock.calls[8]?.[1]?.body));
    expect(markTaskTodoFinishedRequest.command).toBe("mark_task_todo_finished");
    expect(markTaskTodoFinishedRequest.payload).toEqual({ todoId: "todo-1" });
    const listProjectsRequest = JSON.parse(String(fetchMock.mock.calls[9]?.[1]?.body));
    expect(listProjectsRequest.command).toBe("list_projects");
    expect(listProjectsRequest.payload).toEqual({});
    const getProjectRequest = JSON.parse(String(fetchMock.mock.calls[10]?.[1]?.body));
    expect(getProjectRequest.command).toBe("get_project");
    expect(getProjectRequest.payload).toEqual({ projectId: "project-1" });
    const createProjectRequest = JSON.parse(String(fetchMock.mock.calls[11]?.[1]?.body));
    expect(createProjectRequest.command).toBe("create_project");
    expect(createProjectRequest.payload).toEqual({
      input: {
        name: "Bridge project",
        description: "Created through the bridge tool",
      },
    });
    const updateProjectRequest = JSON.parse(String(fetchMock.mock.calls[12]?.[1]?.body));
    expect(updateProjectRequest.command).toBe("update_project");
    expect(updateProjectRequest.payload).toEqual({
      projectId: "project-1",
      input: {
        name: "Updated bridge project",
        description: "Updated through the bridge tool",
      },
    });
    const deleteProjectRequest = JSON.parse(String(fetchMock.mock.calls[13]?.[1]?.body));
    expect(deleteProjectRequest.command).toBe("delete_project");
    expect(deleteProjectRequest.payload).toEqual({ projectId: "project-2" });
    const listRepositoriesRequest = JSON.parse(String(fetchMock.mock.calls[14]?.[1]?.body));
    expect(listRepositoriesRequest.command).toBe("list_repositories");
    expect(listRepositoriesRequest.payload).toEqual({ projectId: "project-1" });
    const getRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[15]?.[1]?.body));
    expect(getRepositoryRequest.command).toBe("get_repository");
    expect(getRepositoryRequest.payload).toEqual({ repositoryId: "repo-1" });
    const createRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[16]?.[1]?.body));
    expect(createRepositoryRequest.command).toBe("create_repository");
    expect(createRepositoryRequest.payload).toEqual({
      projectId: "project-1",
      input: {
        name: "New repo",
        mode: "existing",
        repositoryPath: "/tmp/new-repo",
        defaultBranch: "main",
      },
    });
    const updateRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[17]?.[1]?.body));
    expect(updateRepositoryRequest.command).toBe("update_repository");
    expect(updateRepositoryRequest.payload).toEqual({
      repositoryId: "repo-1",
      input: {
        name: "Updated repo",
        mode: "existing",
        repositoryPath: "/tmp/updated-repo",
        defaultBranch: "develop",
      },
    });
    const deleteRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[18]?.[1]?.body));
    expect(deleteRepositoryRequest.command).toBe("delete_repository");
    expect(deleteRepositoryRequest.payload).toEqual({ repositoryId: "repo-2" });
    const attachRepositoryRemoteRequest = JSON.parse(String(fetchMock.mock.calls[19]?.[1]?.body));
    expect(attachRepositoryRemoteRequest.command).toBe("attach_repository_remote");
    expect(attachRepositoryRemoteRequest.payload).toEqual({
      repositoryId: "repo-1",
      input: {
        remoteUrl: "git@example.com:org/repo.git",
        remoteName: "origin",
      },
    });
    const setProjectDefaultRepositoryRequest = JSON.parse(String(fetchMock.mock.calls[20]?.[1]?.body));
    expect(setProjectDefaultRepositoryRequest.command).toBe("set_project_default_repository");
    expect(setProjectDefaultRepositoryRequest.payload).toEqual({
      projectId: "project-1",
      repositoryId: "repo-1",
    });
    expect(result.details.command).toBe("complete_lane_as_success");
    expect(result.content[0]?.text).toContain("complete_lane_as_success");
    expect(relaneResult.details.command).toBe("reassign_task_to_lane");
    expect(relaneResult.content[0]?.text).toContain("reassign_task_to_lane");
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
    expect(createProjectResult.details.command).toBe("create_project");
    expect(createProjectResult.content[0]?.text).toContain("create_project");
    expect(updateProjectResult.details.command).toBe("update_project");
    expect(updateProjectResult.content[0]?.text).toContain("update_project");
    expect(deleteProjectResult.details.command).toBe("delete_project");
    expect(deleteProjectResult.content[0]?.text).toContain("delete_project");
    expect(listRepositoriesResult.details.command).toBe("list_repositories");
    expect(listRepositoriesResult.content[0]?.text).toContain("list_repositories");
    expect(getRepositoryResult.details.command).toBe("get_repository");
    expect(getRepositoryResult.content[0]?.text).toContain("get_repository");
    expect(createRepositoryResult.details.command).toBe("create_repository");
    expect(createRepositoryResult.content[0]?.text).toContain("create_repository");
    expect(updateRepositoryResult.details.command).toBe("update_repository");
    expect(updateRepositoryResult.content[0]?.text).toContain("update_repository");
    expect(deleteRepositoryResult.details.command).toBe("delete_repository");
    expect(deleteRepositoryResult.content[0]?.text).toContain("delete_repository");
    expect(attachRepositoryRemoteResult.details.command).toBe("attach_repository_remote");
    expect(attachRepositoryRemoteResult.content[0]?.text).toContain("attach_repository_remote");
    expect(setProjectDefaultRepositoryResult.details.command).toBe("set_project_default_repository");
    expect(setProjectDefaultRepositoryResult.content[0]?.text).toContain("set_project_default_repository");
  });

  test("exposes workflow and lane tools with explicit parameters", async () => {
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

    const validateWorkflowTool = registeredTools.find((tool) => tool.name === "validate_workflow");
    expect(validateWorkflowTool.parameters.properties.lanes).toBeTruthy();
    await validateWorkflowTool.execute("tool-call-1", {
      name: "Validation workflow",
      description: "Validate me",
      lanes: [
        {
          key: "plan",
          name: "Plan",
          assignedEntityType: "agent",
          assignedEntityId: "agent-planner",
          successTransitionType: "end",
          failureTransitionType: "end",
        },
      ],
    });

    const addWorkflowLaneTool = registeredTools.find((tool) => tool.name === "add_workflow_lane");
    expect(addWorkflowLaneTool.parameters.properties.workflowId).toBeTruthy();
    await addWorkflowLaneTool.execute("tool-call-2", {
      workflowId: "workflow-1",
      input: {
        key: "review",
        name: "Review",
        assignedEntityType: "role",
        assignedEntityId: "role-reviewer",
        successTransitionType: "end",
        failureTransitionType: "lane",
        failureTargetLaneId: "lane-plan",
      },
    });

    const updateWorkflowLaneTool = registeredTools.find((tool) => tool.name === "update_workflow_lane");
    expect(updateWorkflowLaneTool.parameters.properties.laneId).toBeTruthy();
    await updateWorkflowLaneTool.execute("tool-call-3", {
      workflowId: "workflow-1",
      laneId: "lane-review",
      input: {
        name: "Code review",
        requireUserApprovalOnSuccess: true,
      },
    });

    const deleteWorkflowLaneTool = registeredTools.find((tool) => tool.name === "delete_workflow_lane");
    await deleteWorkflowLaneTool.execute("tool-call-4", {
      workflowId: "workflow-1",
      laneId: "lane-old",
    });

    const reorderWorkflowLanesTool = registeredTools.find((tool) => tool.name === "reorder_workflow_lanes");
    await reorderWorkflowLanesTool.execute("tool-call-5", {
      workflowId: "workflow-1",
      laneIds: ["lane-plan", "lane-review", "lane-done"],
    });

    const createWorkflowTool = registeredTools.find((tool) => tool.name === "create_workflow");
    await createWorkflowTool.execute("tool-call-6", {
      name: "Delivery workflow",
      lanes: [
        {
          key: "implement",
          name: "Implement",
          assignedEntityType: "agent",
          assignedEntityId: "agent-dev",
          successTransitionType: "end",
          failureTransitionType: "end",
        },
      ],
    });

    const duplicateWorkflowTool = registeredTools.find((tool) => tool.name === "duplicate_workflow");
    await duplicateWorkflowTool.execute("tool-call-7", {
      workflowId: "workflow-1",
      newName: "Delivery workflow copy",
    });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    const validateRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(validateRequest.command).toBe("validate_workflow");
    expect(validateRequest.payload.input.name).toBe("Validation workflow");
    const addLaneRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(addLaneRequest.command).toBe("add_workflow_lane");
    expect(addLaneRequest.payload.workflowId).toBe("workflow-1");
    expect(addLaneRequest.payload.input.name).toBe("Review");
    const updateLaneRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(updateLaneRequest.command).toBe("update_workflow_lane");
    expect(updateLaneRequest.payload).toEqual({
      workflowId: "workflow-1",
      laneId: "lane-review",
      input: {
        name: "Code review",
        requireUserApprovalOnSuccess: true,
      },
    });
    const deleteLaneRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(deleteLaneRequest.command).toBe("delete_workflow_lane");
    expect(deleteLaneRequest.payload).toEqual({ workflowId: "workflow-1", laneId: "lane-old" });
    const reorderRequest = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
    expect(reorderRequest.command).toBe("reorder_workflow_lanes");
    expect(reorderRequest.payload).toEqual({
      workflowId: "workflow-1",
      input: { laneIds: ["lane-plan", "lane-review", "lane-done"] },
    });
    const createWorkflowRequest = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body));
    expect(createWorkflowRequest.command).toBe("create_workflow");
    expect(createWorkflowRequest.payload.input.name).toBe("Delivery workflow");
    const duplicateWorkflowRequest = JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body));
    expect(duplicateWorkflowRequest.command).toBe("duplicate_workflow");
    expect(duplicateWorkflowRequest.payload).toEqual({
      workflowId: "workflow-1",
      newName: "Delivery workflow copy",
    });
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
      tags: ["backend", "urgent"],
    });

    const listTasksTool = registeredTools.find((tool) => tool.name === "list_tasks");
    expect(listTasksTool.parameters.properties.projectId).toBeTruthy();
    expect(listTasksTool.parameters.properties.tags).toBeTruthy();
    expect(listTasksTool.parameters.properties.tagMatch).toBeTruthy();
    expect(listTasksTool.parameters.properties.sortBy).toBeTruthy();
    expect(listTasksTool.parameters.properties.sortDirection).toBeTruthy();
    await listTasksTool.execute("tool-call-2", {
      projectId: "project-2",
      includeArchived: false,
      tags: ["backend", "urgent"],
      tagMatch: "all",
      sortBy: "tags",
      sortDirection: "asc",
    });

    const updateTaskTool = registeredTools.find((tool) => tool.name === "update_task");
    expect(updateTaskTool.parameters.properties.taskId).toBeTruthy();
    expect(updateTaskTool.parameters.properties.tags).toBeTruthy();
    expect(updateTaskTool.parameters.properties.inputJson).toBeUndefined();
    await updateTaskTool.execute("tool-call-3", {
      taskId: "task-1",
      title: "Scoped task",
      type: "bug",
      priority: "P1",
      tags: ["backend"],
    });

    const getWorkerOverlayTool = registeredTools.find((tool) => tool.name === "get_worker_overlay");
    expect(getWorkerOverlayTool.parameters.properties.projectSlug).toBeTruthy();
    await getWorkerOverlayTool.execute("tool-call-4", {
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
    });

    const updateWorkerOverlayTool = registeredTools.find((tool) => tool.name === "update_worker_overlay");
    expect(updateWorkerOverlayTool.parameters.properties.projectSlug).toBeTruthy();
    await updateWorkerOverlayTool.execute("tool-call-5", {
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
      prompt: "Use the scoped overlay",
    });

    const helpTool = registeredTools.find((tool) => tool.name === "orchestra_help");
    expect(helpTool.parameters.properties.command).toBeTruthy();
    const helpResult = await helpTool.execute("tool-call-6", { command: "create_task" });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      projectId: "project-2",
      input: {
        title: "Scoped task",
        description: "Create it in the right place",
        type: "bug",
        status: "ready",
        priority: "P1",
        assigneeType: "unassigned",
        tags: ["backend", "urgent"],
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      projectId: "project-2",
      includeArchived: false,
      tags: ["backend", "urgent"],
      tagMatch: "all",
      sortBy: "tags",
      sortDirection: "asc",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).payload).toEqual({
      taskId: "task-1",
      input: {
        title: "Scoped task",
        type: "bug",
        status: "ready",
        priority: "P1",
        assigneeType: "unassigned",
        tags: ["backend"],
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).payload).toEqual({
      workerType: "agent",
      workerSlug: "Data",
      projectSlug: "project-two",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).payload).toEqual({
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
