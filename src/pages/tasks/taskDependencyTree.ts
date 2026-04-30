import type { TaskDetail, TaskSummary } from "../../types";

export type TaskDependencyTreeBranchType = "blocked_by" | "subtasks" | "blocking";

export interface TaskDependencyTreeBranch {
  type: TaskDependencyTreeBranchType;
  nodes: TaskDependencyTreeNode[];
}

export interface TaskDependencyTreeNode {
  task: TaskSummary;
  parent: TaskSummary | null;
  reference: boolean;
  branches: TaskDependencyTreeBranch[];
}

const BRANCH_ORDER: TaskDependencyTreeBranchType[] = ["blocked_by", "subtasks", "blocking"];

export function getTaskDependencyTreeBranchLabel(type: TaskDependencyTreeBranchType) {
  switch (type) {
    case "blocked_by":
      return "Blocked by";
    case "subtasks":
      return "Subtasks";
    case "blocking":
      return "Blocking";
    default:
      return type;
  }
}

function compareTasks(left: TaskSummary, right: TaskSummary) {
  const numberComparison = left.number.localeCompare(right.number, undefined, { numeric: true, sensitivity: "base" });
  if (numberComparison !== 0) {
    return numberComparison;
  }

  const titleComparison = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  if (titleComparison !== 0) {
    return titleComparison;
  }

  return left.id.localeCompare(right.id, undefined, { sensitivity: "base" });
}

function uniqueSortedTasks(tasks: TaskSummary[]) {
  const tasksById = new Map<string, TaskSummary>();
  for (const task of tasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }
  return [...tasksById.values()].sort(compareTasks);
}

export function collectTaskDependencyTreeNeighborIds(task: TaskDetail) {
  return Array.from(new Set([
    ...task.lineage.map((ancestor) => ancestor.id),
    ...(task.parent ? [task.parent.id] : []),
    ...task.children.map((child) => child.id),
    ...task.blockedBy.map((dependency) => dependency.blocker.id),
    ...task.blocking.map((dependency) => dependency.blocked.id),
  ]));
}

export function buildTaskDependencyTree(rootTaskId: string, tasksById: Record<string, TaskDetail>) {
  return buildTaskDependencyTreeNode(rootTaskId, tasksById, new Set<string>(), new Set<string>());
}

function buildTaskDependencyTreeNode(
  taskId: string,
  tasksById: Record<string, TaskDetail>,
  path: Set<string>,
  expandedTaskIds: Set<string>,
): TaskDependencyTreeNode | null {
  const task = tasksById[taskId];
  if (!task) {
    return null;
  }

  if (path.has(taskId) || expandedTaskIds.has(taskId)) {
    return {
      task,
      parent: task.parent ?? null,
      reference: true,
      branches: [],
    };
  }

  expandedTaskIds.add(taskId);
  const nextPath = new Set(path);
  nextPath.add(taskId);

  const relationTasks: Record<TaskDependencyTreeBranchType, TaskSummary[]> = {
    blocked_by: uniqueSortedTasks(task.blockedBy.map((dependency) => dependency.blocker)),
    subtasks: uniqueSortedTasks(task.children),
    blocking: uniqueSortedTasks(task.blocking.map((dependency) => dependency.blocked)),
  };

  const branches = BRANCH_ORDER.flatMap((type) => {
    const nodes = relationTasks[type]
      .map((relatedTask) => buildTaskDependencyTreeNode(relatedTask.id, tasksById, nextPath, expandedTaskIds))
      .filter((node): node is TaskDependencyTreeNode => node !== null);

    return nodes.length ? [{ type, nodes }] : [];
  });

  return {
    task,
    parent: task.parent ?? null,
    reference: false,
    branches,
  };
}
