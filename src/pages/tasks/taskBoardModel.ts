import { getTaskTags } from "../../lib/taskListQuery";
import type { AgentSummary, RoleSummary, TaskSummary, WorkflowDefinition } from "../../types";

export interface TaskBoardLane {
  laneId: string;
  laneName: string;
  tasks: TaskSummary[];
}

export interface TaskWorkflowSection {
  workflowId: string;
  workflowName: string;
  lanes: TaskBoardLane[];
  doneTasks: TaskSummary[];
}

export interface TaskBoardModel {
  draftTasks: TaskSummary[];
  missingWorkflowTasks: TaskSummary[];
  workflowSections: TaskWorkflowSection[];
}

export function getVisibleTaskBoardTasks(board: TaskBoardModel, showDoneTasks: boolean) {
  const workflowTasks = showDoneTasks
    ? board.workflowSections.flatMap((section) => section.doneTasks)
    : board.workflowSections.flatMap((section) => section.lanes.flatMap((lane) => lane.tasks));

  return showDoneTasks
    ? workflowTasks
    : [...board.missingWorkflowTasks, ...board.draftTasks, ...workflowTasks];
}

export function getVisibleTaskBoardTags(board: TaskBoardModel, showDoneTasks: boolean) {
  return Array.from(new Set(getVisibleTaskBoardTasks(board, showDoneTasks).flatMap((task) => getTaskTags(task))))
    .sort((left, right) => left.localeCompare(right));
}

export function isDraftTask(task: TaskSummary) {
  return task.status === "draft";
}

export function hasMissingWorkflow(task: TaskSummary) {
  return task.status !== "draft" && !task.workflowId;
}

export function resolveTaskAssigneeLabel(
  task: TaskSummary,
  agents: AgentSummary[],
  roles: RoleSummary[],
) {
  if (task.assigneeType === "agent") {
    const agent = agents.find((entry) => entry.slug === task.assigneeId || entry.id === task.assigneeId);
    return agent?.name ?? task.assigneeId ?? "Agent";
  }

  if (task.assigneeType === "role") {
    const role = roles.find((entry) => entry.slug === task.assigneeId || entry.id === task.assigneeId);
    return role?.name ?? task.assigneeId ?? "Role";
  }

  if (task.assigneeType === "user") {
    return "User";
  }

  return "Unassigned";
}

export function buildTaskBoardModel(
  tasks: TaskSummary[],
  workflowDefinitions: Record<string, WorkflowDefinition>,
): TaskBoardModel {
  const draftTasks = tasks.filter(isDraftTask);
  const missingWorkflowTasks = tasks.filter(hasMissingWorkflow);
  const workflowBuckets = new Map<string, TaskSummary[]>();

  tasks.filter((task) => !isDraftTask(task) && Boolean(task.workflowId)).forEach((task) => {
    const workflowId = task.workflowId!;
    const current = workflowBuckets.get(workflowId) ?? [];
    current.push(task);
    workflowBuckets.set(workflowId, current);
  });

  const workflowSections: TaskWorkflowSection[] = Array.from(workflowBuckets.entries())
    .map(([workflowId, workflowTasks]) => {
      const workflow = workflowDefinitions[workflowId];
      if (!workflow) {
        return null;
      }

      const lanes = workflow.lanes
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((lane) => ({
          laneId: lane.id,
          laneName: lane.name,
          tasks: workflowTasks.filter((task) => task.currentLaneId === lane.id && !["completed", "canceled"].includes(task.status)),
        }));

      const doneTasks = workflowTasks.filter((task) => ["completed", "canceled"].includes(task.status) || !task.currentLaneId);

      return {
        workflowId,
        workflowName: workflow.name,
        lanes,
        doneTasks,
      } satisfies TaskWorkflowSection;
    })
    .filter((section): section is TaskWorkflowSection => Boolean(section))
    .sort((left, right) => left.workflowName.localeCompare(right.workflowName));

  return {
    draftTasks,
    missingWorkflowTasks,
    workflowSections,
  };
}
