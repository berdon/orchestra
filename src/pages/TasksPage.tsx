import { useEffect, useMemo, useRef, useState } from "react";

import { listAgents } from "../lib/agents";
import { getProject } from "../lib/projects";
import { listRoles } from "../lib/roles";
import {
  addTaskAttachment,
  addTaskDependency,
  addTaskFileReference,
  addTaskTodo,
  approveLaneCompletion,
  commentOnTask,
  deleteTaskComment,
  updateTaskComment,
  completeLaneAsFailure,
  completeLaneAsSuccess,
  createTask,
  createTaskSchedule,
  deleteTask,
  deleteTaskSchedule,
  dispatchTaskLane,
  getTask,
  getTaskSchedule,
  getWorkflow,
  listTaskSchedules,
  listTasks,
  listWorkflows,
  listenToSessionStream,
  listenToTaskChanges,
  removeTaskAttachment,
  removeTaskDependency,
  removeTaskFileReference,
  requestUserIntervention,
  reportClientError,
  resetTaskRuntime,
  sendLaneBackForWork,
  sendSessionMessage,
  setDefaultTaskFileReference,
  stopSessionRuntime,
  manualTaskWhip,
  listTaskMessages,
  markTaskCommentsReadForUser,
  reassignTaskToLane,
  markTaskTodoFinished,
  markTaskTodoUnfinished,
  deleteTaskTodo,
  sendMailboxMessage,
  updateTask,
  updateTaskSchedule,
} from "../lib/tauri";
import type {
  AgentSummary,
  MailboxMessage,
  RepositoryRecord,
  RoleSummary,
  SessionStreamEnvelope,
  TaskCommentInput,
  TaskDetail,
  TaskFileReferenceInput,
  TaskScheduleDetail,
  TaskScheduleSummary,
  TaskScheduleUpsertInput,
  TaskSummary,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowSummary,
} from "../types";
import { TaskCreatePage } from "./tasks/TaskCreatePage";
import { TaskDetailPage } from "./tasks/TaskDetailPage";
import { TaskScheduleDetailPage } from "./tasks/TaskScheduleDetailPage";
import { shouldApplyTaskDetailLoad, shouldApplyTaskScheduleLoad, type TaskDetailRouteState } from "./tasks/taskDetailLoadGuards";
import { buildTaskBoardModel, isDraftTask, type TaskBoardModel } from "./tasks/taskBoardModel";
import { TasksOverviewPage, type TaskBoardFilter, type TaskBoardViewMode } from "./tasks/TasksOverviewPage";

type TasksRoute =
  | { kind: "overview" }
  | { kind: "create"; parentTaskId?: string | null; workflowId?: string | null; scheduled?: boolean }
  | { kind: "detail"; taskId: string }
  | { kind: "schedule"; scheduleId: string };

function toTaskDetailRouteState(route: TasksRoute): TaskDetailRouteState {
  switch (route.kind) {
    case "detail":
      return { kind: "detail", taskId: route.taskId };
    case "schedule":
      return { kind: "schedule", scheduleId: route.scheduleId };
    case "create":
      return { kind: "create" };
    default:
      return { kind: "overview" };
  }
}

function createBlankTaskDraft(): TaskUpsertInput {
  return {
    title: "",
    description: "",
    type: "task",
    status: "draft",
    priority: "P2",
    workflowId: null,
    currentLaneId: null,
    assigneeType: "unassigned",
    assigneeId: null,
    repositoryId: null,
    repositoryIds: [],
    parentTaskId: null,
    whipMaxAttempts: 10,
    archived: false,
  };
}

function createBlankTaskScheduleDraft(taskDraft = createBlankTaskDraft()): TaskScheduleUpsertInput {
  return {
    task: { ...taskDraft, status: "ready", archived: false },
    enabled: true,
    oneShot: false,
    overlapPolicy: "skip",
    trigger: {
      type: "time",
      kind: "daily",
      timeOfDay: "09:00",
      timezone: "UTC",
    },
  };
}

function taskScheduleToDraft(schedule: TaskScheduleDetail): TaskScheduleUpsertInput {
  return {
    task: { ...schedule.taskBlueprint },
    enabled: schedule.enabled,
    oneShot: schedule.oneShot,
    overlapPolicy: schedule.overlapPolicy,
    trigger: schedule.trigger,
  };
}

function createBlankCommentDraft(): TaskCommentInput {
  return {
    author: "User",
    message: "",
    interruptAgent: false,
  };
}

function createBlankFileReferenceDraft(): TaskFileReferenceInput {
  return {
    repositoryId: "",
    relativePath: "",
  };
}

function taskToDraft(task: TaskDetail): TaskUpsertInput {
  return {
    title: task.title,
    description: task.description ?? "",
    type: task.type,
    status: task.status,
    priority: task.priority,
    workflowId: task.workflowId ?? null,
    currentLaneId: task.currentLaneId ?? null,
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId ?? null,
    repositoryId: task.repositoryId ?? null,
    repositoryIds: task.repositoryIds ?? [],
    parentTaskId: task.parentTaskId ?? null,
    whipMaxAttempts: task.whipMaxAttempts ?? 10,
    archived: task.archived,
  };
}

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "file_reference" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

interface TasksPageProps {
  projectId?: string | null;
  createTaskToken?: number;
  createTaskProjectId?: string | null;
  openTaskRequest?: { taskId: string; token: number; projectId: string | null } | null;
  taskBoardViewMode?: TaskBoardViewMode;
  tasksOverviewToken?: number;
  onTaskBoardViewModeChange?: (viewMode: TaskBoardViewMode) => void;
  onSelectedTaskIdChange?: (taskId: string | null) => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenRole?: (roleId: string) => void;
  onOpenSession?: (sessionId: string, projectId?: string | null) => void;
}

function sameData<T>(current: T, next: T) {
  return JSON.stringify(current) === JSON.stringify(next);
}

const TASK_EVENT_TOOL_NAMES = new Set([
  "create_task",
  "create_subtask",
  "add_task_todo",
  "mark_task_todo_finished",
  "mark_task_todo_unfinished",
  "delete_task_todo",
  "update_task",
  "comment_on_task",
  "dispatch_task_lane",
  "complete_lane_as_success",
  "complete_lane_as_failure",
  "request_user_intervention",
  "reassign_task_to_lane",
  "add_task_dependency",
  "remove_task_dependency",
  "add_task_attachment",
  "remove_task_attachment",
]);

function getSessionEventType(payload: SessionStreamEnvelope) {
  if (payload.event && typeof payload.event === "object" && !Array.isArray(payload.event) && "type" in payload.event) {
    const value = payload.event.type;
    return typeof value === "string" ? value : "";
  }

  return "";
}

function shouldRefreshTasksFromSessionEvent(payload: SessionStreamEnvelope) {
  const eventType = getSessionEventType(payload);
  if (eventType === "tool_execution_end") {
    const toolName = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event) && "toolName" in payload.event
      ? payload.event.toolName
      : null;
    return typeof toolName === "string" && TASK_EVENT_TOOL_NAMES.has(toolName);
  }

  return false;
}

export function TasksPage({
  projectId = null,
  createTaskToken = 0,
  createTaskProjectId = null,
  openTaskRequest = null,
  taskBoardViewMode = "cards",
  tasksOverviewToken = 0,
  onTaskBoardViewModeChange,
  onSelectedTaskIdChange,
  onOpenAgent,
  onOpenRole,
  onOpenSession,
}: TasksPageProps) {
  const [route, setRoute] = useState<TasksRoute>({ kind: "overview" });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskSchedules, setTaskSchedules] = useState<TaskScheduleSummary[]>([]);
  const [workflowSummaries, setWorkflowSummaries] = useState<WorkflowSummary[]>([]);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<Record<string, WorkflowDefinition>>({});
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [defaultRepositoryId, setDefaultRepositoryId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskScheduleDetail, setTaskScheduleDetail] = useState<TaskScheduleDetail | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskUpsertInput>(createBlankTaskDraft);
  const [taskScheduleDraft, setTaskScheduleDraft] = useState<TaskScheduleUpsertInput>(createBlankTaskScheduleDraft);
  const [taskScheduleDraftDirty, setTaskScheduleDraftDirty] = useState(false);
  const [creatingScheduledTask, setCreatingScheduledTask] = useState(false);
  const [commentDraft, setCommentDraft] = useState<TaskCommentInput>(createBlankCommentDraft);
  const [fileReferenceDraft, setFileReferenceDraft] = useState<TaskFileReferenceInput>(createBlankFileReferenceDraft);
  const [taskMessages, setTaskMessages] = useState<MailboxMessage[]>([]);
  const [taskDraftDirty, setTaskDraftDirty] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [publishingTask, setPublishingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [closingTask, setClosingTask] = useState(false);
  const [sendingTaskMail, setSendingTaskMail] = useState(false);
  const [detailActionPending, setDetailActionPending] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskBoardFilter>("all");
  const [selectedBlockerTaskId, setSelectedBlockerTaskId] = useState("");
  const createTaskTokenRef = useRef(0);
  const openTaskTokenRef = useRef(0);
  const tasksOverviewTokenRef = useRef(0);
  const lastProjectIdRef = useRef<string | null>(projectId);
  const routeRef = useRef<TaskDetailRouteState>({ kind: "overview" });
  const taskDetailLoadRequestRef = useRef(0);
  const taskScheduleLoadRequestRef = useRef(0);

  const filteredTasks = useMemo(() => {
    switch (taskFilter) {
      case "attention":
        return tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked);
      case "review":
        return tasks.filter((task) => task.status === "in_review");
      case "blocked":
        return tasks.filter((task) => task.status === "blocked" || task.dependencyBlocked);
      case "active":
        return tasks.filter((task) => task.status === "in_progress" || task.readyForDispatch);
      case "done":
        return tasks.filter((task) => task.status === "completed" || task.status === "canceled");
      case "epics":
        return tasks.filter((task) => task.type === "epic");
      default:
        return tasks;
    }
  }, [taskFilter, tasks]);

  const boardModel: TaskBoardModel = useMemo(() => buildTaskBoardModel(filteredTasks, workflowDefinitions), [filteredTasks, workflowDefinitions]);

  const attentionTasks = useMemo(
    () => tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked),
    [tasks],
  );

  async function runDetailAction(actionId: string, operation: () => Promise<void>, fallbackMessage: string) {
    setTaskActionError(null);
    setDetailActionPending(actionId);
    try {
      await operation();
    } catch (error) {
      setTaskActionError(await reportClientError(`ui.tasks.detail_action.${actionId}`, error, fallbackMessage));
    } finally {
      setDetailActionPending(null);
    }
  }

  const timelineItems = useMemo<TaskTimelineItem[]>(() => {
    if (!taskDetail) {
      return [];
    }

    const comments = taskDetail.comments.map<TaskTimelineItem>((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment",
      title: comment.parentCommentId ? `${comment.author} replied` : `${comment.author} commented`,
      description: [
        comment.relativePath && comment.lineStart
          ? `${comment.relativePath} · ${comment.lineStart === comment.lineEnd || !comment.lineEnd ? `line ${comment.lineStart}` : `lines ${comment.lineStart}-${comment.lineEnd}`}`
          : null,
        comment.message,
      ].filter(Boolean).join("\n\n"),
      timestamp: comment.updatedAt,
      tone: comment.interruptAgent ? "warning" : "neutral",
    }));

    const attachments = taskDetail.attachments.map<TaskTimelineItem>((attachment) => ({
      id: `attachment-${attachment.id}`,
      kind: "attachment",
      title: `Attachment added: ${attachment.fileName}`,
      description: `${attachment.mediaType} · ${Math.max(1, Math.round(attachment.byteSize / 1024))} KB`,
      timestamp: attachment.createdAt,
      tone: "neutral",
    }));

    const fileReferences = taskDetail.fileReferences.map<TaskTimelineItem>((reference) => ({
      id: `file-reference-${reference.id}`,
      kind: "file_reference",
      title: `Project file referenced: ${reference.relativePath}`,
      description: `${reference.repositoryName} · ${reference.exists ? "Available" : "Missing"}`,
      timestamp: reference.createdAt,
      tone: reference.exists ? "neutral" : "warning",
    }));

    const laneRuns = taskDetail.laneRuns.map<TaskTimelineItem>((laneRun) => ({
      id: `lane-run-${laneRun.id}`,
      kind: "lane_run",
      title: `Lane ${laneRun.laneId} ${laneRun.completedAt ? "completed" : "started"}`,
      description: `${laneRun.result.replace(/_/g, " ")} · session ${laneRun.sessionId}`,
      timestamp: laneRun.completedAt ?? laneRun.startedAt,
      tone: laneRun.result === "success" ? "success" : laneRun.result === "failure" ? "error" : "neutral",
    }));

    const blockedBy = taskDetail.blockedBy.map<TaskTimelineItem>((dependency) => ({
      id: `dependency-in-${dependency.id}`,
      kind: "dependency_in",
      title: `Blocked by ${dependency.blocker.number}`,
      description: dependency.blocker.title,
      timestamp: dependency.createdAt,
      tone: "warning",
    }));

    const blocking = taskDetail.blocking.map<TaskTimelineItem>((dependency) => ({
      id: `dependency-out-${dependency.id}`,
      kind: "dependency_out",
      title: `Blocking ${dependency.blocked.number}`,
      description: dependency.blocked.title,
      timestamp: dependency.createdAt,
      tone: "neutral",
    }));

    return [...comments, ...attachments, ...fileReferences, ...laneRuns, ...blockedBy, ...blocking].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
    );
  }, [taskDetail]);

  const dependencyCandidates = useMemo(
    () => tasks.filter((task) => route.kind === "detail" && task.id !== route.taskId),
    [route, tasks],
  );

  const taskWorkflowLanes = useMemo(
    () => (taskDetail?.workflowId ? (workflowDefinitions[taskDetail.workflowId]?.lanes ?? []).map((lane) => ({ id: lane.id, name: lane.name })) : []),
    [taskDetail?.workflowId, workflowDefinitions],
  );

  async function loadTasksData(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoadingTasks(true);
      setTaskActionError(null);
    }
    try {
      const [nextTasks, nextSchedules, nextWorkflows, nextAgents, nextRoles, nextProject] = await Promise.all([
        listTasks(false, projectId),
        listTaskSchedules(projectId),
        listWorkflows(false),
        listAgents(false),
        listRoles(false),
        projectId ? getProject(projectId) : Promise.resolve(null),
      ]);
      setTasks((current) => (sameData(current, nextTasks) ? current : nextTasks));
      setTaskSchedules((current) => (sameData(current, nextSchedules) ? current : nextSchedules));
      setWorkflowSummaries((current) => (sameData(current, nextWorkflows) ? current : nextWorkflows));
      setAgents((current) => (sameData(current, nextAgents) ? current : nextAgents));
      setRoles((current) => (sameData(current, nextRoles) ? current : nextRoles));
      setRepositories((current) => (sameData(current, nextProject?.repositories ?? []) ? current : nextProject?.repositories ?? []));
      setDefaultRepositoryId(nextProject?.defaultRepositoryId ?? null);

      const workflowIds: string[] = Array.from(
        new Set(
          nextTasks
            .filter((task: TaskSummary) => Boolean(task.workflowId) && !isDraftTask(task))
            .map((task: TaskSummary) => task.workflowId as string),
        ),
      );
      const definitions = await Promise.all(workflowIds.map((workflowId) => getWorkflow(workflowId)));
      const nextDefinitions = Object.fromEntries(definitions.map((definition) => [definition.id, definition]));
      setWorkflowDefinitions((current) => (sameData(current, nextDefinitions) ? current : nextDefinitions));
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to load tasks.");
    } finally {
      if (!options?.silent) {
        setLoadingTasks(false);
      }
    }
  }

  async function loadTaskDetail(taskId: string, options?: { preserveDraft?: boolean; silent?: boolean }) {
    const requestId = ++taskDetailLoadRequestRef.current;
    if (!options?.silent) {
      setLoadingTaskDetail(true);
      setTaskActionError(null);
    }
    try {
      const [task, messages] = await Promise.all([getTask(taskId), listTaskMessages(taskId)]);
      if (!shouldApplyTaskDetailLoad(routeRef.current, taskId, requestId, taskDetailLoadRequestRef.current)) {
        return;
      }
      setTaskDetail((current) => (sameData(current, task) ? current : task));
      setTaskMessages((current) => (sameData(current, messages) ? current : messages));
      if (!options?.silent) {
        setCommentDraft(createBlankCommentDraft());
        setFileReferenceDraft({
          repositoryId: task.repositoryId ?? task.repositoryIds?.[0] ?? repositories[0]?.id ?? "",
          relativePath: "",
        });
      }
      if (!options?.preserveDraft) {
        const nextDraft = taskToDraft(task);
        setTaskDraft((current) => (sameData(current, nextDraft) ? current : nextDraft));
        setTaskDraftDirty(false);
      }
    } catch (error) {
      if (taskDetailLoadRequestRef.current === requestId) {
        setTaskActionError(error instanceof Error ? error.message : "Unable to load task.");
      }
    } finally {
      if (!options?.silent && taskDetailLoadRequestRef.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }

  async function loadTaskScheduleDetail(scheduleId: string, options?: { preserveDraft?: boolean; silent?: boolean }) {
    const requestId = ++taskScheduleLoadRequestRef.current;
    if (!options?.silent) {
      setLoadingTaskDetail(true);
      setTaskActionError(null);
    }
    try {
      const schedule = await getTaskSchedule(scheduleId);
      if (!shouldApplyTaskScheduleLoad(routeRef.current, scheduleId, requestId, taskScheduleLoadRequestRef.current)) {
        return;
      }
      setTaskScheduleDetail((current) => (sameData(current, schedule) ? current : schedule));
      if (!options?.preserveDraft) {
        const nextDraft = taskScheduleToDraft(schedule);
        setTaskScheduleDraft((current) => (sameData(current, nextDraft) ? current : nextDraft));
        setTaskScheduleDraftDirty(false);
      }
    } catch (error) {
      if (taskScheduleLoadRequestRef.current === requestId) {
        setTaskActionError(error instanceof Error ? error.message : "Unable to load task schedule.");
      }
    } finally {
      if (!options?.silent && taskScheduleLoadRequestRef.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }

  useEffect(() => {
    void loadTasksData();
  }, [projectId]);

  useEffect(() => {
    routeRef.current = toTaskDetailRouteState(route);
  }, [route]);

  useEffect(() => {
    if (route.kind === "detail") {
      void loadTaskDetail(route.taskId, { preserveDraft: taskDraftDirty });
    }
    if (route.kind === "schedule") {
      void loadTaskScheduleDetail(route.scheduleId, { preserveDraft: taskScheduleDraftDirty });
    }
  }, [route.kind === "detail" ? route.taskId : null, route.kind === "schedule" ? route.scheduleId : null]);

  useEffect(() => {
    onSelectedTaskIdChange?.(route.kind === "detail" ? route.taskId : null);
  }, [onSelectedTaskIdChange, route]);

  useEffect(() => {
    if (route.kind === "create") {
      return;
    }

    let cancelled = false;

    const refresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void loadTasksData({ silent: true });
      if (route.kind === "detail" && !taskDraftDirty) {
        void loadTaskDetail(route.taskId, { silent: true });
      }
      if (route.kind === "schedule" && !taskScheduleDraftDirty) {
        void loadTaskScheduleDetail(route.scheduleId, { silent: true });
      }
    };

    let disposeTaskChanges: (() => void) | undefined;
    let disposeSessionStream: (() => void) | undefined;

    void listenToTaskChanges((event) => {
      if (cancelled) {
        return;
      }
      if (event.taskIds.length === 0) {
        refresh();
        return;
      }
      if (route.kind === "detail" && event.taskIds.includes(route.taskId)) {
        refresh();
        return;
      }
      refresh();
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      disposeTaskChanges = dispose;
    });

    void listenToSessionStream((payload) => {
      if (!cancelled && shouldRefreshTasksFromSessionEvent(payload)) {
        refresh();
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      disposeSessionStream = dispose;
    });

    const intervalId = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
      disposeTaskChanges?.();
      disposeSessionStream?.();
    };
  }, [route, taskDraftDirty, taskScheduleDraftDirty, projectId]);

  useEffect(() => {
    if (createTaskProjectId !== projectId || createTaskToken === createTaskTokenRef.current) {
      return;
    }

    createTaskTokenRef.current = createTaskToken;
    openCreateTask();
  }, [createTaskProjectId, createTaskToken, projectId]);

  useEffect(() => {
    if (!openTaskRequest || openTaskRequest.projectId !== projectId || openTaskRequest.token === openTaskTokenRef.current) {
      return;
    }

    openTaskTokenRef.current = openTaskRequest.token;
    openTaskDetail(openTaskRequest.taskId);
  }, [openTaskRequest, projectId]);

  useEffect(() => {
    if (tasksOverviewToken === tasksOverviewTokenRef.current) {
      return;
    }

    tasksOverviewTokenRef.current = tasksOverviewToken;
    taskDetailLoadRequestRef.current += 1;
    taskScheduleLoadRequestRef.current += 1;
    setRoute({ kind: "overview" });
    setTaskDetail(null);
    setTaskMessages([]);
    setTaskScheduleDetail(null);
    setTaskDraft(createBlankTaskDraft());
    setTaskScheduleDraft(createBlankTaskScheduleDraft());
    setCreatingScheduledTask(false);
    setCommentDraft(createBlankCommentDraft());
    setTaskDraftDirty(false);
    setTaskScheduleDraftDirty(false);
    setSelectedBlockerTaskId("");
    setTaskActionError(null);
    setPublishingTask(false);
    setDeletingTask(false);
  }, [tasksOverviewToken]);

  useEffect(() => {
    if (lastProjectIdRef.current === projectId) {
      return;
    }

    lastProjectIdRef.current = projectId;
    taskDetailLoadRequestRef.current += 1;
    taskScheduleLoadRequestRef.current += 1;
    setRoute({ kind: "overview" });
    setTaskDetail(null);
    setTaskMessages([]);
    setTaskScheduleDetail(null);
    setTaskDraft(createBlankTaskDraft());
    setTaskScheduleDraft(createBlankTaskScheduleDraft());
    setCreatingScheduledTask(false);
    setCommentDraft(createBlankCommentDraft());
    setTaskDraftDirty(false);
    setTaskScheduleDraftDirty(false);
    setSelectedBlockerTaskId("");
    setTaskActionError(null);
    setPublishingTask(false);
    setDeletingTask(false);
  }, [projectId]);

  function openCreateTask(parentTaskId?: string | null, workflowId?: string | null, scheduled = false) {
    const nextTaskDraft = {
      ...createBlankTaskDraft(),
      parentTaskId: parentTaskId ?? null,
      workflowId: workflowId ?? null,
      repositoryIds: defaultRepositoryId ? [defaultRepositoryId] : [],
      repositoryId: defaultRepositoryId,
    };
    taskDetailLoadRequestRef.current += 1;
    taskScheduleLoadRequestRef.current += 1;
    setTaskDetail(null);
    setTaskMessages([]);
    setTaskScheduleDetail(null);
    setTaskDraft(nextTaskDraft);
    setTaskScheduleDraft(createBlankTaskScheduleDraft(nextTaskDraft));
    setCreatingScheduledTask(scheduled);
    setCommentDraft(createBlankCommentDraft());
    setFileReferenceDraft({ repositoryId: repositories[0]?.id ?? "", relativePath: "" });
    setTaskDraftDirty(false);
    setTaskScheduleDraftDirty(false);
    setRoute({ kind: "create", parentTaskId: parentTaskId ?? null, workflowId: workflowId ?? null, scheduled });
  }

  function handleTaskBoardViewModeChange(viewMode: TaskBoardViewMode) {
    onTaskBoardViewModeChange?.(viewMode);
  }

  function openTaskDetail(taskId: string) {
    taskDetailLoadRequestRef.current += 1;
    setTaskDetail(null);
    setTaskMessages([]);
    setTaskScheduleDetail(null);
    setRoute({ kind: "detail", taskId });
  }

  function openTaskScheduleDetail(scheduleId: string) {
    taskScheduleLoadRequestRef.current += 1;
    setTaskDetail(null);
    setTaskMessages([]);
    setTaskScheduleDetail(null);
    setRoute({ kind: "schedule", scheduleId });
  }

  function handleScheduledModeChange(scheduled: boolean) {
    setCreatingScheduledTask(scheduled);
    if (scheduled) {
      setTaskScheduleDraft((current) => ({
        ...current,
        task: {
          ...taskDraft,
          status: "ready",
          archived: false,
        },
      }));
      setTaskScheduleDraftDirty(true);
    } else {
      setTaskDraft(taskScheduleDraft.task);
      setTaskDraftDirty(true);
    }
  }

  async function maybeDispatchPublishedTask(taskId: string) {
    const latest = await getTask(taskId);
    if (latest.readyForDispatch) {
      await dispatchTaskLane(taskId);
    }
  }

  async function handleSaveCreateTask() {
    setSavingTask(true);
    setTaskActionError(null);
    try {
      if (creatingScheduledTask) {
        const saved = await createTaskSchedule({ ...taskScheduleDraft, enabled: false }, projectId);
        await loadTasksData();
        setRoute({ kind: "schedule", scheduleId: saved.id });
        await loadTaskScheduleDetail(saved.id);
        setTaskScheduleDraftDirty(false);
      } else {
        const saved = await createTask({ ...taskDraft, status: "draft" }, projectId);
        await loadTasksData();
        setRoute({ kind: "detail", taskId: saved.id });
        await loadTaskDetail(saved.id);
        setTaskDraftDirty(false);
        setSelectedBlockerTaskId("");
      }
    } catch (error) {
      setTaskActionError(
        await reportClientError(
          creatingScheduledTask ? "ui.task_schedule.create.save.failed" : "ui.task.create.save.failed",
          error,
          creatingScheduledTask ? "Unable to save task schedule." : "Unable to create task.",
        ),
      );
    } finally {
      setSavingTask(false);
    }
  }

  async function handlePublishCreateTask() {
    setPublishingTask(true);
    setTaskActionError(null);
    try {
      if (creatingScheduledTask) {
        const saved = await createTaskSchedule({ ...taskScheduleDraft, enabled: true }, projectId);
        await loadTasksData();
        setRoute({ kind: "schedule", scheduleId: saved.id });
        await loadTaskScheduleDetail(saved.id);
        setTaskScheduleDraftDirty(false);
      } else {
        const saved = await createTask({ ...taskDraft, status: "ready" }, projectId);
        await maybeDispatchPublishedTask(saved.id);
        await loadTasksData();
        setRoute({ kind: "detail", taskId: saved.id });
        await loadTaskDetail(saved.id);
        setTaskDraftDirty(false);
        setSelectedBlockerTaskId("");
      }
    } catch (error) {
      setTaskActionError(
        await reportClientError(
          creatingScheduledTask ? "ui.task_schedule.create.publish.failed" : "ui.task.create.publish.failed",
          error,
          creatingScheduledTask ? "Unable to create task schedule." : "Unable to publish task.",
        ),
      );
    } finally {
      setPublishingTask(false);
    }
  }

  async function handleSaveDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setSavingTask(true);
    await runDetailAction("save", async () => {
      const saved = await updateTask(route.taskId, taskDraft);
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    }, "Unable to save task.");
    setSavingTask(false);
  }

  async function handleSaveTaskScheduleDetail() {
    if (route.kind !== "schedule") {
      return;
    }
    setSavingTask(true);
    await runDetailAction("save_schedule", async () => {
      const saved = await updateTaskSchedule(route.scheduleId, taskScheduleDraft);
      await loadTasksData();
      await loadTaskScheduleDetail(saved.id);
      setTaskScheduleDraftDirty(false);
    }, "Unable to save task schedule.");
    setSavingTask(false);
  }

  async function handlePublishDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setPublishingTask(true);
    await runDetailAction("publish", async () => {
      const saved = await updateTask(route.taskId, { ...taskDraft, status: "ready" });
      await maybeDispatchPublishedTask(saved.id);
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    }, "Unable to publish task.");
    setPublishingTask(false);
  }

  async function handleDeleteDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setDeletingTask(true);
    await runDetailAction("delete", async () => {
      await deleteTask(route.taskId);
      await loadTasksData();
      setRoute({ kind: "overview" });
      setTaskDetail(null);
      setTaskDraft(createBlankTaskDraft());
      setCommentDraft(createBlankCommentDraft());
      setFileReferenceDraft(createBlankFileReferenceDraft());
      setTaskDraftDirty(false);
      setSelectedBlockerTaskId("");
    }, "Unable to delete task.");
    setDeletingTask(false);
  }

  async function handleCloseDetailTask(reason?: string) {
    if (route.kind !== "detail") {
      return;
    }
    setClosingTask(true);
    await runDetailAction("close", async () => {
      let currentTask = taskDetail ?? await getTask(route.taskId);
      const trimmedReason = reason?.trim();
      if (trimmedReason) {
        await commentOnTask(route.taskId, {
          author: commentDraft.author || "User",
          message: `Task canceled: ${trimmedReason}`,
          interruptAgent: false,
        });
        currentTask = await getTask(route.taskId);
      }
      if (currentTask.activeLaneAssignment) {
        await resetTaskRuntime(route.taskId);
      }
      const saved = await updateTask(route.taskId, {
        ...taskToDraft(currentTask),
        ...taskDraft,
        status: "canceled",
      });
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    }, "Unable to close task.");
    setClosingTask(false);
  }

  async function handleDeleteTaskScheduleDetail() {
    if (route.kind !== "schedule") {
      return;
    }
    setDeletingTask(true);
    await runDetailAction("delete_schedule", async () => {
      await deleteTaskSchedule(route.scheduleId);
      await loadTasksData();
      setRoute({ kind: "overview" });
      setTaskScheduleDetail(null);
      setTaskScheduleDraft(createBlankTaskScheduleDraft());
      setTaskScheduleDraftDirty(false);
    }, "Unable to delete task schedule.");
    setDeletingTask(false);
  }

  async function handleAddDependency() {
    if (route.kind !== "detail" || !selectedBlockerTaskId) {
      return;
    }
    setTaskActionError(null);
    try {
      await addTaskDependency(selectedBlockerTaskId, route.taskId);
      setSelectedBlockerTaskId("");
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add dependency.");
    }
  }

  async function handleRemoveDependency(dependencyId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await removeTaskDependency(dependencyId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to remove dependency.");
    }
  }

  async function handleAttachmentInputChange(files: FileList | null) {
    if (route.kind !== "detail" || !files?.length) {
      return;
    }
    setTaskActionError(null);
    try {
      for (const file of Array.from(files)) {
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
          reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const commaIndex = result.indexOf(",");
            resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
          };
          reader.readAsDataURL(file);
        });

        await addTaskAttachment(route.taskId, {
          fileName: file.name,
          mediaType: file.type || "application/octet-stream",
          base64Data,
          caption: null,
        });
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add attachment.");
    }
  }

  async function handleRemoveAttachment(attachmentId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await removeTaskAttachment(attachmentId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to remove attachment.");
    }
  }

  async function handleAddFileReference() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await addTaskFileReference(route.taskId, fileReferenceDraft);
      setFileReferenceDraft({ repositoryId: fileReferenceDraft.repositoryId || (repositories[0]?.id ?? ""), relativePath: "" });
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRemoveFileReference(referenceId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await removeTaskFileReference(referenceId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to remove file reference.");
    }
  }

  async function handleSetDefaultFileReference(referenceId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await setDefaultTaskFileReference(referenceId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to set default file reference.");
    }
  }

  async function handleAddTaskTodo(description: string, laneId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await addTaskTodo(route.taskId, { description, laneId });
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add task todo.");
    }
  }

  async function handleMarkTaskTodoFinished(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-finished-${todoId}`, async () => {
      await markTaskTodoFinished(todoId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to mark task todo finished.");
  }

  async function handleMarkTaskTodoUnfinished(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-unfinished-${todoId}`, async () => {
      await markTaskTodoUnfinished(todoId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to mark task todo unfinished.");
  }

  async function handleDeleteTaskTodo(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-delete-${todoId}`, async () => {
      await deleteTaskTodo(todoId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to delete task todo.");
  }

  async function handleMarkTaskCommentsReadForUser() {
    if (route.kind !== "detail" || !taskDetail?.unreadCommentCount) {
      return;
    }
    setTaskActionError(null);
    try {
      await markTaskCommentsReadForUser(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to mark task comments read.");
    }
  }

  async function handleAddComment(draft: TaskCommentInput): Promise<boolean> {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      await commentOnTask(route.taskId, draft);
      if (!draft.parentCommentId) {
        setCommentDraft(createBlankCommentDraft());
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
      return true;
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add comment.");
      return false;
    }
  }

  async function handleUpdateComment(commentId: string, message: string): Promise<boolean> {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      await updateTaskComment(commentId, { message });
      await loadTasksData();
      await loadTaskDetail(route.taskId);
      return true;
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to update comment.");
      return false;
    }
  }

  async function handleDeleteComment(commentId: string): Promise<boolean> {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      await deleteTaskComment(commentId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
      return true;
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to delete comment.");
      return false;
    }
  }

  async function handleSendTaskMail(body: string, interrupt: boolean) {
    if (route.kind !== "detail") {
      return;
    }
    setSendingTaskMail(true);
    setTaskActionError(null);
    try {
      await sendMailboxMessage({
        projectId: taskDetail?.projectId ?? projectId ?? null,
        taskId: route.taskId,
        recipientType: "active_assignment",
        body,
        priority: interrupt ? "interrupt" : "normal",
      });
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to send task mail.");
      throw error;
    } finally {
      setSendingTaskMail(false);
    }
  }

  async function handleDispatchTaskLane() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("dispatch-ready", async () => {
      await dispatchTaskLane(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to dispatch task lane.");
  }

  async function handleCompleteLane(outcome: "success" | "failure" | "needs_user") {
    if (route.kind !== "detail") {
      return;
    }
    const actionId = outcome === "success" ? "approve-user" : outcome === "failure" ? "needs-work-user" : "needs-user";
    await runDetailAction(actionId, async () => {
      if (outcome === "success") {
        await completeLaneAsSuccess(route.taskId);
      } else if (outcome === "failure") {
        await completeLaneAsFailure(route.taskId);
      } else {
        await requestUserIntervention(route.taskId);
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to complete task lane.");
  }

  async function handleApproveLaneCompletion() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("approve-pending", async () => {
      await approveLaneCompletion(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to approve task lane.");
  }

  async function handleRelaneTask(targetLaneId: string, notes?: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("relane", async () => {
      await reassignTaskToLane(route.taskId, targetLaneId, notes);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to re-lane task.");
  }

  async function handleSendLaneBackForWork() {
    if (route.kind !== "detail") {
      return;
    }
    const actionId = taskDetail?.activeLaneAssignment?.status === "awaiting_user_intervention"
      ? "resume-pending"
      : "needs-work-pending";
    await runDetailAction(actionId, async () => {
      await sendLaneBackForWork(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, taskDetail?.activeLaneAssignment?.status === "awaiting_user_intervention"
      ? "Unable to resume task lane."
      : "Unable to send task lane back for work.");
  }

  async function handlePauseTaskRuntime() {
    const sessionId = taskDetail?.activeLaneAssignment?.sessionId ?? null;
    if (route.kind !== "detail" || !sessionId) {
      return;
    }
    await runDetailAction("pause", async () => {
      await stopSessionRuntime(sessionId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to pause task runtime.");
  }

  async function handleWhipTask() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("whip", async () => {
      const activeSessionId = taskDetail?.activeLaneAssignment?.sessionId ?? null;
      if (activeSessionId) {
        await sendSessionMessage(
          activeSessionId,
          `Keep working until you are done - when you are done use tool \`complete_lane_as_success\` (with the task ID and optional notes) unless you believe either you or the task that was sent to you failed - then use tool \`complete_lane_as_failure\` (with task ID and optional notes). If you believe you need to escalate to the user - use tool \`request_user_intervention\` (with task ID and optional notes).\n\nCanonical task ID: ${route.taskId}`,
          `manual-whip-${Date.now()}`,
        );
      }
      await manualTaskWhip(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to send manual task whip.");
  }

  async function handleResetTaskRuntime() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("reset", async () => {
      const activeSessionId = taskDetail?.activeLaneAssignment?.sessionId ?? null;
      if (activeSessionId) {
        await stopSessionRuntime(activeSessionId);
      }
      await resetTaskRuntime(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to reset task runtime.");
  }

  async function handleRetryTaskLane() {
    if (route.kind !== "detail" || !taskDetail || !taskDetail.workflowId || !taskDetail.currentLaneId) {
      return;
    }

    setTaskActionError(null);
    try {
      const activeSessionId = taskDetail.activeLaneAssignment?.sessionId ?? null;
      if (activeSessionId) {
        await sendSessionMessage(
          activeSessionId,
          "Keep working this ticket and use the tools complete_lane_as_success, complete_lane_as_failure, and request_user_intervention to mark the work as completed.",
          `retry-task-${taskDetail.id}-${Date.now()}`,
        );
        return;
      }

      if (taskDetail.readyForDispatch) {
        await dispatchTaskLane(taskDetail.id);
        await loadTasksData();
        await loadTaskDetail(taskDetail.id);
        return;
      }

      throw new Error("This task is not currently dispatchable for retry.");
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to retry task lane.");
    }
  }

  if (typeof window !== "undefined") {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
    };
    testWindow.__orchestraTestOpenTaskDetail = openTaskDetail;
  }

  return (
    <section className="panel-stack task-page-stack">
      {taskActionError ? <p className="error-copy">{taskActionError}</p> : null}
      {loadingTasks ? <p className="muted-copy">Loading tasks…</p> : null}

      {route.kind === "overview" ? (
        <TasksOverviewPage
          agents={agents}
          allTasks={tasks}
          attentionTasks={attentionTasks}
          board={boardModel}
          filter={taskFilter}
          onFilterChange={setTaskFilter}
          onOpenTask={openTaskDetail}
          onOpenSchedule={openTaskScheduleDetail}
          onViewModeChange={handleTaskBoardViewModeChange}
          roles={roles}
          schedules={taskSchedules}
          viewMode={taskBoardViewMode}
        />
      ) : route.kind === "create" ? (
        <TaskCreatePage
          agents={agents}
          draft={taskDraft}
          scheduleDraft={taskScheduleDraft}
          scheduledMode={creatingScheduledTask}
          onBack={() => setRoute({ kind: "overview" })}
          onChange={(draft) => {
            setTaskDraft(draft);
            setTaskDraftDirty(true);
            if (creatingScheduledTask) {
              setTaskScheduleDraft((current) => ({ ...current, task: { ...draft, status: "ready", archived: false } }));
              setTaskScheduleDraftDirty(true);
            }
          }}
          onScheduleChange={(draft) => {
            setTaskScheduleDraft(draft);
            setTaskScheduleDraftDirty(true);
          }}
          onScheduledModeChange={handleScheduledModeChange}
          onPublish={() => void handlePublishCreateTask()}
          onSave={() => void handleSaveCreateTask()}
          repositories={repositories}
          roles={roles}
          saving={savingTask || publishingTask}
          workflows={workflowSummaries}
        />
      ) : route.kind === "schedule" && taskScheduleDetail ? (
        <TaskScheduleDetailPage
          agents={agents}
          deleting={deletingTask}
          draft={taskScheduleDraft}
          loading={loadingTaskDetail}
          onDelete={() => void handleDeleteTaskScheduleDetail()}
          onDraftChange={(draft) => {
            setTaskScheduleDraft(draft);
            setTaskScheduleDraftDirty(true);
          }}
          onOpenTask={openTaskDetail}
          onSave={() => void handleSaveTaskScheduleDetail()}
          repositories={repositories}
          roles={roles}
          saving={savingTask}
          schedule={taskScheduleDetail}
          workflows={workflowSummaries}
        />
      ) : route.kind === "detail" && taskDetail?.id === route.taskId ? (
        <TaskDetailPage
          agents={agents}
          commentDraft={commentDraft}
          tasks={tasks}
          deleting={deletingTask}
          closing={closingTask}
          dependencyCandidates={dependencyCandidates.map((task) => ({ id: task.id, number: task.number, title: task.title }))}
          draft={taskDraft}
          fileReferenceDraft={fileReferenceDraft}
          loading={loadingTaskDetail}
          onAddAttachment={(files) => void handleAttachmentInputChange(files)}
          onAddComment={(draft) => handleAddComment(draft)}
          onAddTaskTodo={(description, laneId) => void handleAddTaskTodo(description, laneId)}
          onDeleteComment={(commentId) => handleDeleteComment(commentId)}
          onDeleteTaskTodo={(todoId) => void handleDeleteTaskTodo(todoId)}
          onAddDependency={() => void handleAddDependency()}
          onAddFileReference={() => void handleAddFileReference()}
          onApproveCompletion={() => void handleApproveLaneCompletion()}
          onCommentDraftChange={setCommentDraft}
          onCommentsTabViewed={() => void handleMarkTaskCommentsReadForUser()}
          onComplete={(outcome) => void handleCompleteLane(outcome)}
          onClose={(reason) => void handleCloseDetailTask(reason)}
          onDelete={() => void handleDeleteDetailTask()}
          onDispatch={() => void handleDispatchTaskLane()}
          onDraftChange={(draft) => {
            setTaskDraft(draft);
            setTaskDraftDirty(true);
          }}
          onFileReferenceDraftChange={setFileReferenceDraft}
          onOpenTask={openTaskDetail}
          onOpenSession={onOpenSession ?? (() => {})}
          onOpenAgent={onOpenAgent ?? (() => {})}
          onOpenRole={onOpenRole ?? (() => {})}
          onPublish={() => void handlePublishDetailTask()}
          onUpdateComment={(commentId, message) => handleUpdateComment(commentId, message)}
          onRemoveAttachment={(attachmentId) => void handleRemoveAttachment(attachmentId)}
          onRetry={() => void handleRetryTaskLane()}
          onPauseRuntime={() => void handlePauseTaskRuntime()}
          onWhipTask={() => void handleWhipTask()}
          onResetTask={() => void handleResetTaskRuntime()}
          onRelane={(laneId, notes) => void handleRelaneTask(laneId, notes)}
          onSendBackForWork={() => void handleSendLaneBackForWork()}
          onRemoveDependency={(dependencyId) => void handleRemoveDependency(dependencyId)}
          onRemoveFileReference={(referenceId) => void handleRemoveFileReference(referenceId)}
          onSetDefaultFileReference={(referenceId) => void handleSetDefaultFileReference(referenceId)}
          onMarkTaskTodoFinished={(todoId) => void handleMarkTaskTodoFinished(todoId)}
          onMarkTaskTodoUnfinished={(todoId) => void handleMarkTaskTodoUnfinished(todoId)}
          onSave={() => void handleSaveDetailTask()}
          onSelectBlocker={setSelectedBlockerTaskId}
          pendingActionId={detailActionPending}
          publishing={publishingTask}
          roles={roles}
          repositories={repositories}
          saving={savingTask}
          selectedBlockerTaskId={selectedBlockerTaskId}
          sendingMail={sendingTaskMail}
          task={taskDetail}
          taskMessages={taskMessages}
          timelineItems={timelineItems}
          workflows={workflowSummaries}
          workflowLanes={taskWorkflowLanes}
          onSendMail={(body, interrupt) => handleSendTaskMail(body, interrupt)}
        />
      ) : route.kind === "detail" ? (
        <section className="panel empty-state">
          <p className="eyebrow">Task detail</p>
          <h3>Loading task</h3>
          <p>Refreshing the selected task detail…</p>
        </section>
      ) : route.kind === "schedule" ? (
        <section className="panel empty-state">
          <p className="eyebrow">Task schedule</p>
          <h3>Loading schedule</h3>
          <p>Refreshing the selected schedule detail…</p>
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="eyebrow">No task selected</p>
          <h3>Choose a task</h3>
          <p>Return to the board to choose a task or create a new one.</p>
        </section>
      )}
    </section>
  );
}
