import { beforeEach, describe, expect, test, vi } from "vitest";

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("blocked task runtime mock parity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", {
      localStorage: createStorage(),
      location: { search: "", href: "http://localhost/" },
      dispatchEvent: vi.fn(() => true),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  test("mock mode preserves an active lane assignment when a task becomes blocked", async () => {
    const { createProject } = await import("../src/lib/projects");
    const { createRole } = await import("../src/lib/roles");
    const { createWorkflow, createTask, dispatchTaskLane, getTask, updateTask } = await import("../src/lib/tauri");

    await createProject({ name: "Blocked Runtime Mock Project", description: "mock project", taskPrefix: "BRM" });
    const role = await createRole({
      name: "Mock Blocked Runtime Role",
      description: "Role for blocked runtime mock coverage.",
      systemPrompt: "Work the task.",
      capacity: 1,
    });
    const workflow = await createWorkflow({
      name: "Mock Blocked Runtime Flow",
      description: "Single role lane flow.",
      lanes: [
        {
          id: "lane-implement",
          key: "implement",
          name: "Implement",
          order: 0,
          assignedEntityType: "role",
          assignedEntityId: role.slug,
          entryPromptTemplate: "Implement the work.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "end",
          failureTargetLaneId: null,
        },
      ],
    });
    const task = await createTask({
      title: "Mock blocked runtime task",
      description: "Dispatch me, then block me.",
      type: "task",
      status: "ready",
      priority: "P1",
      workflowId: workflow.id,
      currentLaneId: "lane-implement",
      assigneeType: "unassigned",
      assigneeId: null,
    });

    const dispatched = await dispatchTaskLane(task.id);
    expect(dispatched.activeLaneAssignment?.sessionId).toBeTruthy();

    await updateTask(task.id, {
      title: dispatched.title,
      description: dispatched.description,
      type: dispatched.type,
      status: "blocked",
      priority: dispatched.priority,
      workflowId: dispatched.workflowId,
      currentLaneId: dispatched.currentLaneId,
      assigneeType: dispatched.assigneeType,
      assigneeId: dispatched.assigneeId,
      repositoryId: dispatched.repositoryId,
      repositoryIds: dispatched.repositoryIds,
      parentTaskId: dispatched.parentTaskId,
      archived: dispatched.archived,
    });

    const blocked = await getTask(task.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.activeLaneAssignment?.status).toBe("active");
    expect(blocked.activeLaneAssignment?.sessionId).toBeTruthy();
    expect(blocked.readyForDispatch).toBe(false);
  });

  test("mock mode stops a blocked active task when it tries to transition and leaves it blocked", async () => {
    const { createProject } = await import("../src/lib/projects");
    const { createRole } = await import("../src/lib/roles");
    const { createWorkflow, createTask, dispatchTaskLane, getTask, updateTask, completeLaneAsSuccess } = await import("../src/lib/tauri");

    await createProject({ name: "Blocked Transition Mock Project", description: "mock project", taskPrefix: "BTM" });
    const role = await createRole({
      name: "Mock Blocked Transition Role",
      description: "Role for blocked transition mock coverage.",
      systemPrompt: "Work the task.",
      capacity: 1,
    });
    const workflow = await createWorkflow({
      name: "Mock Blocked Transition Flow",
      description: "Single role lane flow.",
      lanes: [
        {
          id: "lane-implement",
          key: "implement",
          name: "Implement",
          order: 0,
          assignedEntityType: "role",
          assignedEntityId: role.slug,
          entryPromptTemplate: "Implement the work.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "end",
          failureTargetLaneId: null,
        },
      ],
    });
    const task = await createTask({
      title: "Mock blocked transition task",
      description: "Dispatch me, block me, then attempt completion.",
      type: "task",
      status: "ready",
      priority: "P1",
      workflowId: workflow.id,
      currentLaneId: "lane-implement",
      assigneeType: "unassigned",
      assigneeId: null,
    });

    const dispatched = await dispatchTaskLane(task.id);
    await updateTask(task.id, {
      title: dispatched.title,
      description: dispatched.description,
      type: dispatched.type,
      status: "blocked",
      priority: dispatched.priority,
      workflowId: dispatched.workflowId,
      currentLaneId: dispatched.currentLaneId,
      assigneeType: dispatched.assigneeType,
      assigneeId: dispatched.assigneeId,
      repositoryId: dispatched.repositoryId,
      repositoryIds: dispatched.repositoryIds,
      parentTaskId: dispatched.parentTaskId,
      archived: dispatched.archived,
    });

    const blocked = await completeLaneAsSuccess(task.id, "Tried to finish while blocked.");
    expect(blocked.status).toBe("blocked");
    expect(blocked.activeLaneAssignment).toBeNull();
    expect(blocked.currentLaneId).toBe("lane-implement");
    expect(blocked.laneRuns.at(-1)?.result).toBe("blocked");
  });

  test("mock mode unblocks a dependent when the blocker advances to the Test lane", async () => {
    const { createProject } = await import("../src/lib/projects");
    const { createRole } = await import("../src/lib/roles");
    const { createWorkflow, createTask, addTaskDependency, completeLaneAsSuccess, getTask } = await import("../src/lib/tauri");

    await createProject({ name: "Dependency Test Lane Mock Project", description: "mock project", taskPrefix: "DTM" });
    const role = await createRole({
      name: "Mock Dependency Implementer",
      description: "Role for dependency lane coverage.",
      systemPrompt: "Implement the work.",
      capacity: 1,
    });
    const blockerWorkflow = await createWorkflow({
      name: "Mock Blocker Implement Test Flow",
      description: "Implement lane advances to Test.",
      lanes: [
        {
          id: "lane-implement",
          key: "implement",
          name: "Implement",
          order: 0,
          assignedEntityType: "role",
          assignedEntityId: role.slug,
          entryPromptTemplate: "Implement the blocker.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "lane",
          successTargetLaneId: "lane-test",
          failureTransitionType: "end",
          failureTargetLaneId: null,
        },
        {
          id: "lane-test",
          key: "test",
          name: "Test",
          order: 1,
          assignedEntityType: "user",
          assignedEntityId: null,
          entryPromptTemplate: "Test the blocker.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "lane",
          failureTargetLaneId: "lane-implement",
        },
      ],
    });
    const dependentWorkflow = await createWorkflow({
      name: "Mock Dependent Flow",
      description: "Dependent work lane.",
      lanes: [
        {
          id: "lane-dependent-implement",
          key: "implement",
          name: "Implement",
          order: 0,
          assignedEntityType: "user",
          assignedEntityId: null,
          entryPromptTemplate: "Implement dependent work.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "end",
          failureTargetLaneId: null,
        },
      ],
    });

    const blocker = await createTask({
      title: "Mock blocker to test",
      description: "Advancing this to Test should unblock the dependent.",
      type: "task",
      status: "ready",
      priority: "P1",
      workflowId: blockerWorkflow.id,
      currentLaneId: "lane-implement",
      assigneeType: "role",
      assigneeId: role.slug,
    });
    const dependent = await createTask({
      title: "Mock dependent blocked until test",
      description: "Should be runnable once the blocker reaches Test.",
      type: "task",
      status: "ready",
      priority: "P2",
      workflowId: dependentWorkflow.id,
      currentLaneId: "lane-dependent-implement",
      assigneeType: "unassigned",
      assigneeId: null,
    });

    await addTaskDependency(blocker.id, dependent.id);
    const blocked = await getTask(dependent.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.dependencyBlocked).toBe(true);
    expect(blocked.readyForDispatch).toBe(false);

    const transitioned = await completeLaneAsSuccess(blocker.id, "Implementation ready for Test.");
    expect(transitioned.status).toBe("in_review");
    expect(transitioned.currentLaneId).toBe("lane-test");

    const unblocked = await getTask(dependent.id);
    expect(unblocked.status).toBe("ready");
    expect(unblocked.dependencyBlocked).toBe(false);
    expect(unblocked.readyForDispatch).toBe(true);
  });

  test("mock mode rejects dispatch for initially blocked tasks", async () => {
    const { createProject } = await import("../src/lib/projects");
    const { createRole } = await import("../src/lib/roles");
    const { createWorkflow, createTask, dispatchTaskLane } = await import("../src/lib/tauri");

    await createProject({ name: "Initially Blocked Mock Project", description: "mock project", taskPrefix: "IBM" });
    const role = await createRole({
      name: "Mock Initially Blocked Role",
      description: "Role for initially blocked mock coverage.",
      systemPrompt: "Work the task.",
      capacity: 1,
    });
    const workflow = await createWorkflow({
      name: "Mock Initially Blocked Flow",
      description: "Single role lane flow.",
      lanes: [
        {
          id: "lane-implement",
          key: "implement",
          name: "Implement",
          order: 0,
          assignedEntityType: "role",
          assignedEntityId: role.slug,
          entryPromptTemplate: "Implement the work.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "end",
          failureTargetLaneId: null,
        },
      ],
    });
    const blockedTask = await createTask({
      title: "Initially blocked mock task",
      description: "Should never dispatch.",
      type: "task",
      status: "blocked",
      priority: "P2",
      workflowId: workflow.id,
      currentLaneId: "lane-implement",
      assigneeType: "role",
      assigneeId: role.slug,
    });

    await expect(dispatchTaskLane(blockedTask.id)).rejects.toThrow(/blocked and cannot be dispatched/i);
  });
});
