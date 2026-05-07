import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import orchestraToolsExtension from "../extensions/orchestra-tools";

describe("orchestra tools extension bridge tool setup", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

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
        name: "create_agent",
        description: "Create an Orchestra agent",
        requiredPermission: "agents.create",
      },
      {
        name: "update_agent",
        description: "Update an Orchestra agent",
        requiredPermission: "agents.update",
      },
      {
        name: "create_subtask",
        description: "Create a subtask",
        requiredPermission: "tasks.create",
      },
      {
        name: "add_task_attachment",
        description: "Add a task attachment",
        requiredPermission: "tasks.attachments.write",
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
        name: "list_notes",
        description: "List project and repository notes",
        requiredPermission: "notes.read",
      },
      {
        name: "get_note",
        description: "Get a note",
        requiredPermission: "notes.read",
      },
      {
        name: "update_note",
        description: "Create or update a note",
        requiredPermission: "notes.write",
      },
      {
        name: "delete_note",
        description: "Delete a note",
        requiredPermission: "notes.write",
      },
      {
        name: "copy_note",
        description: "Copy a note",
        requiredPermission: "notes.write",
      },
      {
        name: "move_note",
        description: "Move a note",
        requiredPermission: "notes.write",
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
        name: "list_sessions",
        description: "List and filter Orchestra sessions",
        requiredPermission: "sessions.read",
      },
      {
        name: "get_session_diagnostics",
        description: "Inspect detailed Orchestra session diagnostics",
        requiredPermission: "sessions.read",
      },
      {
        name: "hide_sessions",
        description: "Hide or dismiss sessions from the session list",
        requiredPermission: "sessions.delete",
      },
      {
        name: "restore_sessions",
        description: "Restore user-dismissed sessions to the session list",
        requiredPermission: "sessions.delete",
      },
      {
        name: "delete_sessions",
        description: "Hard-delete sessions and associated state",
        requiredPermission: "sessions.delete",
      },
      {
        name: "reconcile_sessions",
        description: "Reconcile orphaned or stale session catalog/list/origin state",
        requiredPermission: "sessions.delete",
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
        name: "list_project_secrets",
        description: "List project secret metadata without raw values",
        requiredPermission: "projects.secrets.read",
      },
      {
        name: "search_project_secrets",
        description: "Search project secret metadata without raw values",
        requiredPermission: "projects.secrets.read",
      },
      {
        name: "get_project_secret",
        description: "Load a project secret into the session environment",
        requiredPermission: "projects.secrets.use",
      },
      {
        name: "add_project_secret",
        description: "Create a project secret from an env-sourced value",
        requiredPermission: "projects.secrets.write",
      },
      {
        name: "update_project_secret",
        description: "Update a project secret from an env-sourced value",
        requiredPermission: "projects.secrets.write",
      },
      {
        name: "delete_project_secret",
        description: "Delete a project secret",
        requiredPermission: "projects.secrets.write",
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
      {
        name: "get_workflow_delete_impact",
        description: "Inspect whether a workflow can be deleted",
        requiredPermission: "workflows.read",
      },
      {
        name: "delete_workflow",
        description: "Delete a workflow",
        requiredPermission: "workflows.delete",
      },
    ]);
    process.env.ORCHESTRA_AUTH_CONTEXT_JSON = JSON.stringify({ actorType: "user", actorId: "tester" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
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
        "list_sessions",
        "get_session_diagnostics",
        "hide_sessions",
        "restore_sessions",
        "delete_sessions",
        "reconcile_sessions",
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
        "list_project_secrets",
        "search_project_secrets",
        "get_project_secret",
        "add_project_secret",
        "update_project_secret",
        "delete_project_secret",
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
        "get_workflow_delete_impact",
        "delete_workflow",
      ]),
    );
    expect(registeredTools.map((tool) => tool.name)).not.toContain("orchestra_command");

    const completionTool = registeredTools.find((tool) => tool.name === "complete_lane_as_success");
    expect(completionTool.parameters.properties.taskId).toBeTruthy();
    expect(completionTool.parameters.properties.summary).toBeTruthy();
    expect(completionTool.parameters.required).toContain("summary");
    expect(completionTool.parameters.properties.inputJson).toBeUndefined();
    const result = await completionTool.execute("tool-call-1", {
      taskId: "task-1",
      summary: "Implementation complete and ready to hand off.",
      notes: "Ship it",
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
    expect(request.payload).toEqual({
      taskId: "task-1",
      summary: "Implementation complete and ready to hand off.",
      notes: "Ship it",
    });
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

  test("supports attaching a readable session-local file via filePath with inferred metadata", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "orchestra-attachment-tool-"));
    try {
      const artifactsDir = join(tempDir, "artifacts");
      const attachmentPath = join(artifactsDir, "ci-output.log");
      await fs.mkdir(artifactsDir, { recursive: true });
      await fs.writeFile(attachmentPath, "failure output\nsecond line\n", "utf8");
      const resolvedAttachmentPath = await fs.realpath(attachmentPath);
      process.chdir(tempDir);

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

      const attachmentTool = registeredTools.find((tool) => tool.name === "add_task_attachment");
      expect(attachmentTool.parameters.properties.input.properties.filePath).toBeTruthy();
      expect(attachmentTool.parameters.properties.input.properties.base64Data).toBeTruthy();
      expect(attachmentTool.helpNotes).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Prefer input.filePath"),
          expect.stringContaining("Relative filePath values resolve"),
        ]),
      );
      expect(attachmentTool.helpExamples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            input: expect.objectContaining({ filePath: "./artifacts/ci-output.log" }),
          }),
        ]),
      );

      const result = await attachmentTool.execute("tool-call-file-attachment", {
        taskId: "task-1",
        input: {
          filePath: "./artifacts/ci-output.log",
          caption: "CI failure excerpt",
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(request.command).toBe("add_task_attachment");
      expect(request.payload).toEqual({
        taskId: "task-1",
        input: {
          fileName: "ci-output.log",
          mediaType: "text/plain",
          base64Data: Buffer.from("failure output\nsecond line\n").toString("base64"),
          caption: "CI failure excerpt",
        },
      });
      expect(result.details.attachmentInput).toEqual({
        inputMode: "filePath",
        filePath: "./artifacts/ci-output.log",
        resolvedPath: resolvedAttachmentPath,
        fileName: "ci-output.log",
        mediaType: "text/plain",
        caption: "CI failure excerpt",
      });
      expect(result.content[0]?.text).toContain("add_task_attachment");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("supports filePath overrides and preserves base64 attachment compatibility", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "orchestra-attachment-tool-"));
    try {
      const attachmentPath = join(tempDir, "raw.bin");
      await fs.writeFile(attachmentPath, Buffer.from([0, 1, 2, 3]));
      const resolvedAttachmentPath = await fs.realpath(attachmentPath);

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

      const attachmentTool = registeredTools.find((tool) => tool.name === "add_task_attachment");
      const filePathResult = await attachmentTool.execute("tool-call-file-attachment-overrides", {
        taskId: "task-1",
        input: {
          filePath: attachmentPath,
          fileName: "artifact.txt",
          mediaType: "text/custom",
        },
      });
      const base64Result = await attachmentTool.execute("tool-call-base64-attachment", {
        taskId: "task-2",
        input: {
          fileName: "error.log",
          mediaType: "text/plain",
          base64Data: "ZXhhbXBsZSBsb2c=",
          caption: "Existing flow",
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const filePathRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(filePathRequest.payload).toEqual({
        taskId: "task-1",
        input: {
          fileName: "artifact.txt",
          mediaType: "text/custom",
          base64Data: Buffer.from([0, 1, 2, 3]).toString("base64"),
        },
      });
      const base64Request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      expect(base64Request.payload).toEqual({
        taskId: "task-2",
        input: {
          fileName: "error.log",
          mediaType: "text/plain",
          base64Data: "ZXhhbXBsZSBsb2c=",
          caption: "Existing flow",
        },
      });
      expect(filePathResult.details.attachmentInput).toEqual({
        inputMode: "filePath",
        filePath: attachmentPath,
        resolvedPath: resolvedAttachmentPath,
        fileName: "artifact.txt",
        mediaType: "text/custom",
      });
      expect(base64Result.details.attachmentInput).toEqual({
        inputMode: "base64Data",
        fileName: "error.log",
        mediaType: "text/plain",
        caption: "Existing flow",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects missing, non-file, and unreadable attachment paths before invoking the bridge", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "orchestra-attachment-tool-"));
    try {
      const attachmentPath = join(tempDir, "secret.log");
      const directoryPath = join(tempDir, "logs");
      await fs.writeFile(attachmentPath, "secret", "utf8");
      await fs.mkdir(directoryPath, { recursive: true });
      const resolvedAttachmentPath = await fs.realpath(attachmentPath);
      const resolvedDirectoryPath = await fs.realpath(directoryPath);

      const registeredTools: Array<any> = [];
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      orchestraToolsExtension({
        registerTool(tool: any) {
          registeredTools.push(tool);
        },
        registerCommand() {},
      } as any);

      const attachmentTool = registeredTools.find((tool) => tool.name === "add_task_attachment");

      await expect(
        attachmentTool.execute("tool-call-missing-attachment", {
          taskId: "task-1",
          input: { filePath: join(tempDir, "missing.log") },
        }),
      ).rejects.toThrow(`Attachment file was not found: ${join(tempDir, "missing.log")}`);

      await expect(
        attachmentTool.execute("tool-call-directory-attachment", {
          taskId: "task-1",
          input: { filePath: directoryPath },
        }),
      ).rejects.toThrow(`Attachment file must be a regular readable file, not a directory: ${resolvedDirectoryPath}`);

      vi.spyOn(fs, "access").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      await expect(
        attachmentTool.execute("tool-call-unreadable-attachment", {
          taskId: "task-1",
          input: { filePath: attachmentPath },
        }),
      ).rejects.toThrow(`Attachment file is not readable from this session: ${resolvedAttachmentPath}`);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("exposes typed session management tools", async () => {
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

    const listSessionsTool = registeredTools.find((tool) => tool.name === "list_sessions");
    expect(listSessionsTool.parameters.properties.projectId).toBeTruthy();
    expect(listSessionsTool.parameters.properties.query).toBeTruthy();
    expect(listSessionsTool.parameters.properties.catalogPresent).toBeTruthy();
    expect(listSessionsTool.parameters.properties.inputJson).toBeUndefined();

    const deleteSessionsTool = registeredTools.find((tool) => tool.name === "delete_sessions");
    expect(deleteSessionsTool.parameters.properties.sessionIds).toBeTruthy();
    expect(deleteSessionsTool.parameters.properties.dryRun).toBeTruthy();
    expect(deleteSessionsTool.parameters.properties.stopActiveRuntimes).toBeTruthy();

    await listSessionsTool.execute("tool-call-list-sessions", {
      projectId: "project-1",
      query: "Larry main session",
      hidden: true,
      limit: 5,
    });
    const deleteResult = await deleteSessionsTool.execute("tool-call-delete-sessions", {
      query: "Larry main session",
      hidden: true,
      dryRun: false,
      confirm: true,
      stopActiveRuntimes: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(listRequest.command).toBe("list_sessions");
    expect(listRequest.payload).toEqual({
      projectId: "project-1",
      query: "Larry main session",
      hidden: true,
      limit: 5,
    });
    const deleteRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(deleteRequest.command).toBe("delete_sessions");
    expect(deleteRequest.payload).toEqual({
      query: "Larry main session",
      hidden: true,
      dryRun: false,
      confirm: true,
      stopActiveRuntimes: true,
    });
    expect(deleteResult.details.command).toBe("delete_sessions");
  });

  test("exposes typed project note tools", async () => {
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

    const listNotesTool = registeredTools.find((tool) => tool.name === "list_notes");
    expect(listNotesTool.parameters.properties.projectId).toBeTruthy();

    const getNoteTool = registeredTools.find((tool) => tool.name === "get_note");
    expect(getNoteTool.parameters.properties.location).toBeTruthy();

    const updateNoteTool = registeredTools.find((tool) => tool.name === "update_note");
    expect(updateNoteTool.parameters.properties.markdown).toBeTruthy();

    const copyNoteTool = registeredTools.find((tool) => tool.name === "copy_note");
    expect(copyNoteTool.parameters.properties.source).toBeTruthy();
    expect(copyNoteTool.parameters.properties.destination).toBeTruthy();

    await listNotesTool.execute("tool-call-list-notes", {
      projectId: "project-1",
    });
    await getNoteTool.execute("tool-call-get-note", {
      projectId: "project-1",
      location: {
        scope: "project",
        path: "plans/roadmap.md",
      },
    });
    await updateNoteTool.execute("tool-call-update-note", {
      projectId: "project-1",
      location: {
        scope: "repository",
        repositoryId: "repo-1",
        path: "docs/guide.md",
      },
      markdown: "# Guide\n",
    });
    await copyNoteTool.execute("tool-call-copy-note", {
      projectId: "project-1",
      source: {
        scope: "project",
        path: "plans/roadmap.md",
      },
      destination: {
        scope: "repository",
        repositoryId: "repo-1",
        path: "plans/roadmap-copy.md",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const listRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(listRequest.command).toBe("list_notes");
    expect(listRequest.payload).toEqual({ projectId: "project-1" });
    const getRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(getRequest.command).toBe("get_note");
    expect(getRequest.payload.location.path).toBe("plans/roadmap.md");
    const updateRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(updateRequest.command).toBe("update_note");
    expect(updateRequest.payload.markdown).toBe("# Guide\n");
    const copyRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(copyRequest.command).toBe("copy_note");
    expect(copyRequest.payload.destination.repositoryId).toBe("repo-1");
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
        needsWorkTargetLaneId: null,
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

    const workflowDeleteImpactTool = registeredTools.find((tool) => tool.name === "get_workflow_delete_impact");
    await workflowDeleteImpactTool.execute("tool-call-8", {
      workflowId: "workflow-1",
    });

    const deleteWorkflowTool = registeredTools.find((tool) => tool.name === "delete_workflow");
    await deleteWorkflowTool.execute("tool-call-9", {
      workflowId: "workflow-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(9);
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
        needsWorkTargetLaneId: null,
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
    const deleteImpactRequest = JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body));
    expect(deleteImpactRequest.command).toBe("get_workflow_delete_impact");
    expect(deleteImpactRequest.payload).toEqual({ workflowId: "workflow-1" });
    const deleteWorkflowRequest = JSON.parse(String(fetchMock.mock.calls[8]?.[1]?.body));
    expect(deleteWorkflowRequest.command).toBe("delete_workflow");
    expect(deleteWorkflowRequest.payload).toEqual({ workflowId: "workflow-1" });
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

  test("exposes safe project-secret tools without returning raw values in tool details or UI commands", async () => {
    const registeredTools: Array<any> = [];
    const registeredCommands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const notifications: Array<{ message: string; level: string }> = [];
    process.env.OPENAI_SOURCE = "sk-secret-from-env";

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      async json() {
        const request = JSON.parse(String(init?.body));
        if (request.command === "get_project_secret") {
          return {
            success: true,
            data: {
              projectSlug: "secret-project",
              secretKey: request.payload.secretKey,
              value: "sk-loaded-from-bridge",
            },
          };
        }
        return {
          success: true,
          data: {
            echoedCommand: request.command,
            echoedPayload: request.payload,
          },
        };
      },
    }));

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, definition: any) {
        registeredCommands.set(name, definition.handler);
      },
    } as any);

    const searchProjectSecretsTool = registeredTools.find((tool) => tool.name === "search_project_secrets");
    expect(searchProjectSecretsTool.parameters.properties.projectSlug).toBeTruthy();
    expect(searchProjectSecretsTool.parameters.properties.query).toBeTruthy();
    expect(searchProjectSecretsTool.parameters.properties.secretKey).toBeTruthy();
    expect(searchProjectSecretsTool.parameters.properties.valueState).toBeTruthy();
    expect(searchProjectSecretsTool.parameters.properties.hasDescription).toBeTruthy();
    await searchProjectSecretsTool.execute("tool-call-1", {
      projectSlug: "secret-project",
      query: "openai",
      valueState: "ready",
      hasDescription: true,
    });

    const getProjectSecretTool = registeredTools.find((tool) => tool.name === "get_project_secret");
    const loadResult = await getProjectSecretTool.execute("tool-call-2", {
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
      targetEnvVar: "OPENAI_TOKEN",
    });

    expect(loadResult.content[0]?.text).toContain("Loaded OPENAI_API_KEY into env var OPENAI_TOKEN");
    expect(loadResult.details.result).toEqual({
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
      targetEnvVar: "OPENAI_TOKEN",
      loaded: true,
    });
    expect(JSON.stringify(loadResult.details.result)).not.toContain("sk-loaded-from-bridge");
    expect(process.env.OPENAI_TOKEN).toBe("sk-loaded-from-bridge");

    const updateProjectSecretTool = registeredTools.find((tool) => tool.name === "update_project_secret");
    await updateProjectSecretTool.execute("tool-call-3", {
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
      description: "Rotated key",
      sourceEnvVar: "OPENAI_SOURCE",
    });

    const orchestraRun = registeredCommands.get("orchestra-run");
    expect(orchestraRun).toBeTruthy();
    await orchestraRun?.("get_project_secret {\"projectSlug\":\"secret-project\",\"secretKey\":\"OPENAI_API_KEY\",\"targetEnvVar\":\"OPENAI_RUNTIME\"}", {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      projectSlug: "secret-project",
      query: "openai",
      valueState: "ready",
      hasDescription: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).payload).toEqual({
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
      description: "Rotated key",
      value: "sk-secret-from-env",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).payload).toEqual({
      projectSlug: "secret-project",
      secretKey: "OPENAI_API_KEY",
    });
    expect(notifications).toEqual([
      {
        message: "Loaded OPENAI_API_KEY into env var OPENAI_RUNTIME for this session.",
        level: "info",
      },
    ]);
    expect(process.env.OPENAI_RUNTIME).toBe("sk-loaded-from-bridge");
  });

  test("documents project-secret safety notes and examples in orchestra_help", async () => {
    const registeredTools: Array<any> = [];
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand() {},
    } as any);

    const helpTool = registeredTools.find((tool) => tool.name === "orchestra_help");
    const addHelp = JSON.parse((await helpTool.execute("tool-call-1", { command: "add_project_secret" })).content[0]?.text ?? "{}");
    const updateHelp = JSON.parse((await helpTool.execute("tool-call-2", { command: "update_project_secret" })).content[0]?.text ?? "{}");
    const loadHelp = JSON.parse((await helpTool.execute("tool-call-3", { command: "get_project_secret" })).content[0]?.text ?? "{}");

    expect(addHelp.requiredPermission).toBe("projects.secrets.write");
    expect(addHelp.parameters.find((parameter: any) => parameter.name === "sourceEnvVar")).toEqual(
      expect.objectContaining({ required: true }),
    );
    expect(updateHelp.requiredPermission).toBe("projects.secrets.write");
    expect(updateHelp.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sourceEnvVar"),
        expect.stringContaining("omit sourceEnvVar"),
        expect.stringContaining("raw value field is rejected"),
      ]),
    );
    expect(updateHelp.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          secretKey: "OPENAI_API_KEY",
          sourceEnvVar: "OPENAI_SOURCE",
        }),
        expect.objectContaining({
          secretKey: "OPENAI_API_KEY",
          description: "Primary provider key",
        }),
      ]),
    );
    expect(updateHelp.parameters.find((parameter: any) => parameter.name === "sourceEnvVar")).toEqual(
      expect.objectContaining({ required: false }),
    );
    expect(loadHelp.requiredPermission).toBe("projects.secrets.use");
    expect(loadHelp.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("never returns the raw secret value"),
        expect.stringContaining("targetEnvVar"),
      ]),
    );
  });

  test("rejects direct raw project-secret write values in tool and /orchestra-run inputs", async () => {
    process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON = JSON.stringify([
      {
        name: "update_project_secret",
        description: "Update a project secret from an env-sourced value",
        requiredPermission: "projects.secrets.write",
      },
    ]);

    const registeredTools: Array<any> = [];
    const registeredCommands = new Map<string, any>();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, definition: any) {
        registeredCommands.set(name, definition);
      },
    } as any);

    const updateProjectSecretTool = registeredTools.find((tool) => tool.name === "update_project_secret");
    await expect(
      updateProjectSecretTool.execute("tool-call-update-secret", {
        secretKey: "OPENAI_API_KEY",
        sourceEnvVar: "SOURCE_SECRET",
        value: "sk-inline",
      } as any),
    ).rejects.toThrow("does not accept a raw value argument");

    const orchestraRun = registeredCommands.get("orchestra-run");
    await expect(
      orchestraRun.handler(
        'update_project_secret {"secretKey":"OPENAI_API_KEY","sourceEnvVar":"SOURCE_SECRET","value":"sk-inline"}',
        { ui: { notify: vi.fn() } },
      ),
    ).rejects.toThrow("does not accept a raw value argument");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("documents nested input structures and examples for wrapped Orchestra payloads", async () => {
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

    const createAgentTool = registeredTools.find((tool) => tool.name === "create_agent");
    expect(createAgentTool.parameters.properties.input).toBeTruthy();
    expect(createAgentTool.parameters.properties.inputJson).toBeUndefined();
    await createAgentTool.execute("tool-call-1", {
      input: {
        name: "Planner",
        scope: "project",
        projectId: "project-1",
        systemPrompt: "Plan carefully",
        thinkingLevel: "medium",
        policyIds: ["policy-1"],
      },
    });

    const createSubtaskTool = registeredTools.find((tool) => tool.name === "create_subtask");
    expect(createSubtaskTool.parameters.properties.parentTaskId).toBeTruthy();
    expect(createSubtaskTool.parameters.properties.input).toBeTruthy();
    await createSubtaskTool.execute("tool-call-2", {
      parentTaskId: "task-parent",
      input: {
        title: "Write regression coverage",
        description: "Add tests for the failing case",
        priority: "P1",
      },
    });

    const helpTool = registeredTools.find((tool) => tool.name === "orchestra_help");
    const helpResult = await helpTool.execute("tool-call-3", { command: "create_agent" });
    const parsedHelp = JSON.parse(helpResult.content[0]?.text ?? "{}");
    const inputParameter = parsedHelp.parameters.find((parameter: any) => parameter.name === "input");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      input: {
        name: "Planner",
        scope: "project",
        projectId: "project-1",
        systemPrompt: "Plan carefully",
        thinkingLevel: "medium",
        policyIds: ["policy-1"],
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      parentTaskId: "task-parent",
      input: {
        title: "Write regression coverage",
        description: "Add tests for the failing case",
        type: "task",
        status: "ready",
        priority: "P1",
        assigneeType: "unassigned",
      },
    });
    expect(parsedHelp.command).toBe("create_agent");
    expect(parsedHelp.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("top-level input property"),
        expect.stringContaining("camelCase"),
      ]),
    );
    expect(parsedHelp.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            name: "Planner",
            systemPrompt: "You are a planning specialist.",
          }),
        }),
      ]),
    );
    expect(inputParameter.description).toContain("top-level input");
    expect(inputParameter.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "name", required: true, type: "string" }),
        expect.objectContaining({ name: "systemPrompt", required: false, type: "string" }),
        expect.objectContaining({ name: "projectId", required: false, type: "string" }),
        expect.objectContaining({ name: "policyIds", required: false, type: "array<string>" }),
      ]),
    );
  });

  test("supports metadata-only project secret updates in tool and /orchestra-run flows", async () => {
    process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON = JSON.stringify([
      {
        name: "update_project_secret",
        description: "Update a project secret from an env-sourced value",
        requiredPermission: "projects.secrets.write",
      },
    ]);

    const registeredTools: Array<any> = [];
    const registeredCommands = new Map<string, any>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      async json() {
        return {
          success: true,
          data: {
            projectSlug: "test-project",
            availability: { status: "available", message: null },
            secrets: [{ secretKey: "OPENAI_API_KEY", description: "Metadata only" }],
          },
        };
      },
    }));

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, definition: any) {
        registeredCommands.set(name, definition);
      },
    } as any);

    const updateProjectSecretTool = registeredTools.find((tool) => tool.name === "update_project_secret");
    const result = await updateProjectSecretTool.execute("tool-call-update-secret", {
      secretKey: "OPENAI_API_KEY",
      description: "Metadata only",
    });

    expect(result.content[0]?.text).not.toContain("sk-");
    expect(JSON.stringify(result.details)).not.toContain("sourceEnvVar");
    const firstRequestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstRequestBody.command).toBe("update_project_secret");
    expect(firstRequestBody.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Metadata only",
    });
    expect(result.details.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Metadata only",
      projectId: undefined,
      projectSlug: undefined,
      taskId: undefined,
    });

    const orchestraRun = registeredCommands.get("orchestra-run");
    const notify = vi.fn();
    await orchestraRun.handler('update_project_secret {"secretKey":"OPENAI_API_KEY","description":"Metadata only"}', {
      ui: { notify },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondRequestBody.command).toBe("update_project_secret");
    expect(secondRequestBody.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Metadata only",
    });
    expect(notify).toHaveBeenCalledWith(expect.any(String), "info");
    const notifyPayload = JSON.parse(String(notify.mock.calls[0]?.[0]));
    expect(notifyPayload.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Metadata only",
    });
    expect(JSON.stringify(notifyPayload)).not.toContain("sourceEnvVar");
  });

  test("writes project secrets from existing session env vars", async () => {
    process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON = JSON.stringify([
      {
        name: "update_project_secret",
        description: "Update a project secret from an env-sourced value",
        requiredPermission: "projects.secrets.write",
      },
    ]);
    process.env.SOURCE_SECRET = "sk-env-source";

    const registeredTools: Array<any> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      async json() {
        return {
          success: true,
          data: {
            projectSlug: "test-project",
            availability: { status: "available", message: null },
            secrets: [{ secretKey: "OPENAI_API_KEY", valueState: "ready" }],
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

    const updateProjectSecretTool = registeredTools.find((tool) => tool.name === "update_project_secret");
    const result = await updateProjectSecretTool.execute("tool-call-update-secret", {
      secretKey: "OPENAI_API_KEY",
      description: "Rotated key",
      sourceEnvVar: "SOURCE_SECRET",
    });

    expect(result.content[0]?.text).not.toContain("sk-env-source");
    expect(JSON.stringify(result.details)).not.toContain("sk-env-source");
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.command).toBe("update_project_secret");
    expect(requestBody.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Rotated key",
      value: "sk-env-source",
    });
    expect(result.details.payload).toEqual({
      secretKey: "OPENAI_API_KEY",
      description: "Rotated key",
      sourceEnvVar: "SOURCE_SECRET",
      projectId: undefined,
      projectSlug: undefined,
      taskId: undefined,
    });
  });

  test("loads project secrets into session env and routes orchestra-run through the same safe wrapper", async () => {
    process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON = JSON.stringify([
      {
        name: "get_project_secret",
        description: "Load a project secret into the session environment",
        requiredPermission: "projects.secrets.use",
      },
    ]);

    const registeredTools: Array<any> = [];
    const registeredCommands = new Map<string, any>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      async json() {
        return {
          success: true,
          data: {
            projectSlug: "test-project",
            secretKey: "OPENAI_API_KEY",
            value: "sk-super-secret",
          },
        };
      },
    }));

    vi.stubGlobal("fetch", fetchMock);

    orchestraToolsExtension({
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, definition: any) {
        registeredCommands.set(name, definition);
      },
    } as any);

    const getProjectSecretTool = registeredTools.find((tool) => tool.name === "get_project_secret");
    expect(getProjectSecretTool.parameters.properties.secretKey).toBeTruthy();
    expect(getProjectSecretTool.parameters.properties.sourceEnvVar).toBeUndefined();

    const toolResult = await getProjectSecretTool.execute("tool-call-secret", {
      secretKey: "OPENAI_API_KEY",
    });
    expect(toolResult.content[0]?.text).toContain("Loaded OPENAI_API_KEY into env var OPENAI_API_KEY");
    expect(toolResult.content[0]?.text).not.toContain("sk-super-secret");
    expect(JSON.stringify(toolResult.details)).not.toContain("sk-super-secret");
    expect(process.env.OPENAI_API_KEY).toBe("sk-super-secret");

    const orchestraRun = registeredCommands.get("orchestra-run");
    const notify = vi.fn();
    await orchestraRun.handler("get_project_secret {\"secretKey\":\"OPENAI_API_KEY\",\"targetEnvVar\":\"OPENAI_TOKEN\"}", {
      ui: { notify },
    });
    expect(notify).toHaveBeenCalledWith("Loaded OPENAI_API_KEY into env var OPENAI_TOKEN for this session.", "info");
    expect(process.env.OPENAI_TOKEN).toBe("sk-super-secret");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstRequest.command).toBe("get_project_secret");
    expect(firstRequest.payload).toEqual({ secretKey: "OPENAI_API_KEY" });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondRequest.command).toBe("get_project_secret");
    expect(secondRequest.payload).toEqual({ secretKey: "OPENAI_API_KEY" });
  });
});
