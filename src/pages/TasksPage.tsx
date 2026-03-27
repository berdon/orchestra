import { useEffect, useMemo, useRef, useState } from "react";

import { listAgents } from "../lib/agents";
import { getProject } from "../lib/projects";
import { listRoles } from "../lib/roles";
import {
  addTaskAttachment,
  addTaskDependency,
  addTaskFileReference,
  approveLaneCompletion,
  commentOnTask,
  completeLaneAsFailure,
  completeLaneAsSuccess,
  createTask,
  deleteTask,
  dispatchTaskLane,
  getTask,
  getWorkflow,
  listTasks,
  listWorkflows,
  listenToSessionStream,
  listenToTaskChanges,
  removeTaskAttachment,
  removeTaskDependency,
  removeTaskFileReference,
  requestUserIntervention,
  sendLaneBackForWork,
  sendSessionMessage,
  setDefaultTaskFileReference,
  stopSessionRuntime,
  manualTaskWhip,
  updateTask,
} from "../lib/tauri";
import type {
  AgentSummary,
  RepositoryRecord,
  RoleSummary,
  SessionStreamEnvelope,
  TaskCommentInput,
  TaskDetail,
  TaskFileReferenceInput,
  TaskSummary,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowSummary,
} from "../types";
import { TaskCreatePage } from "./tasks/TaskCreatePage";
import { TaskDetailPage } from "./tasks/TaskDetailPage";
import { buildTaskBoardModel, isDraftTask, type TaskBoardModel } from "./tasks/taskBoardModel";
import { TasksOverviewPage, type TaskBoardFilter, type TaskBoardViewMode } from "./tasks/TasksOverviewPage";

type TasksRoute =
  | { kind: "overview" }
  | { kind: "create"; parentTaskId?: string | null; workflowId?: string | null }
  | { kind: "detail"; taskId: string };

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
  onTaskBoardViewModeChange?: (viewMode: TaskBoardViewMode) => void;
}

function sameData<T>(current: T, next: T) {
  return JSON.stringify(current) === JSON.stringify(next);
}

const TASK_EVENT_TOOL_NAMES = new Set([
  "create_task",
  "create_subtask",
  "update_task",
  "comment_on_task",
  "dispatch_task_lane",
  "complete_lane_as_success",
  "complete_lane_as_failure",
  "request_user_intervention",
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
  onTaskBoardViewModeChange,
}: TasksPageProps) {
  const [route, setRoute] = useState<TasksRoute>({ kind: "overview" });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [workflowSummaries, setWorkflowSummaries] = useState<WorkflowSummary[]>([]);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<Record<string, WorkflowDefinition>>({});
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [defaultRepositoryId, setDefaultRepositoryId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskUpsertInput>(createBlankTaskDraft);
  const [commentDraft, setCommentDraft] = useState<TaskCommentInput>(createBlankCommentDraft);
  const [fileReferenceDraft, setFileReferenceDraft] = useState<TaskFileReferenceInput>(createBlankFileReferenceDraft);
  const [taskDraftDirty, setTaskDraftDirty] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [publishingTask, setPublishingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskBoardFilter>("all");
  const [selectedBlockerTaskId, setSelectedBlockerTaskId] = useState("");
  const createTaskTokenRef = useRef(0);
  const openTaskTokenRef = useRef(0);

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

  const timelineItems = useMemo<TaskTimelineItem[]>(() => {
    if (!taskDetail) {
      return [];
    }

    const comments = taskDetail.comments.map<TaskTimelineItem>((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment",
      title: comment.parentCommentId ? `${comment.author} replied` : `${comment.author} commented`,
      description: comment.message,
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

  async function loadTasksData(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoadingTasks(true);
      setTaskActionError(null);
    }
    try {
      const [nextTasks, nextWorkflows, nextAgents, nextRoles, nextProject] = await Promise.all([
        listTasks(false, projectId),
        listWorkflows(false),
        listAgents(false),
        listRoles(false),
        projectId ? getProject(projectId) : Promise.resolve(null),
      ]);
      setTasks((current) => (sameData(current, nextTasks) ? current : nextTasks));
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
    if (!options?.silent) {
      setLoadingTaskDetail(true);
      setTaskActionError(null);
    }
    try {
      const task = await getTask(taskId);
      setTaskDetail((current) => (sameData(current, task) ? current : task));
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
      setTaskActionError(error instanceof Error ? error.message : "Unable to load task.");
    } finally {
      if (!options?.silent) {
        setLoadingTaskDetail(false);
      }
    }
  }

  useEffect(() => {
    void loadTasksData();
  }, [projectId]);

  useEffect(() => {
    if (route.kind === "detail") {
      void loadTaskDetail(route.taskId, { preserveDraft: taskDraftDirty });
    }
  }, [route.kind === "detail" ? route.taskId : null]);

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
  }, [route, taskDraftDirty, projectId]);

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
    setRoute({ kind: "overview" });
    setTaskDetail(null);
    setTaskDraft(createBlankTaskDraft());
    setCommentDraft(createBlankCommentDraft());
    setTaskDraftDirty(false);
    setSelectedBlockerTaskId("");
    setTaskActionError(null);
    setPublishingTask(false);
    setDeletingTask(false);
  }, [projectId]);

  function openCreateTask(parentTaskId?: string | null, workflowId?: string | null) {
    setTaskDraft({
      ...createBlankTaskDraft(),
      parentTaskId: parentTaskId ?? null,
      workflowId: workflowId ?? null,
      repositoryIds: defaultRepositoryId ? [defaultRepositoryId] : [],
      repositoryId: defaultRepositoryId,
    });
    setCommentDraft(createBlankCommentDraft());
    setFileReferenceDraft({ repositoryId: repositories[0]?.id ?? "", relativePath: "" });
    setTaskDraftDirty(false);
    setRoute({ kind: "create", parentTaskId: parentTaskId ?? null, workflowId: workflowId ?? null });
  }

  function handleTaskBoardViewModeChange(viewMode: TaskBoardViewMode) {
    onTaskBoardViewModeChange?.(viewMode);
  }

  function openTaskDetail(taskId: string) {
    setRoute({ kind: "detail", taskId });
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
      const saved = await createTask({ ...taskDraft, status: "draft" }, projectId);
      await loadTasksData();
      setRoute({ kind: "detail", taskId: saved.id });
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
      setSelectedBlockerTaskId("");
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to create task.");
    } finally {
      setSavingTask(false);
    }
  }

  async function handlePublishCreateTask() {
    setPublishingTask(true);
    setTaskActionError(null);
    try {
      const saved = await createTask({ ...taskDraft, status: "ready" }, projectId);
      await maybeDispatchPublishedTask(saved.id);
      await loadTasksData();
      setRoute({ kind: "detail", taskId: saved.id });
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
      setSelectedBlockerTaskId("");
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to publish task.");
    } finally {
      setPublishingTask(false);
    }
  }

  async function handleSaveDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setSavingTask(true);
    setTaskActionError(null);
    try {
      const saved = await updateTask(route.taskId, taskDraft);
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to save task.");
    } finally {
      setSavingTask(false);
    }
  }

  async function handlePublishDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setPublishingTask(true);
    setTaskActionError(null);
    try {
      const saved = await updateTask(route.taskId, { ...taskDraft, status: "ready" });
      await maybeDispatchPublishedTask(saved.id);
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to publish task.");
    } finally {
      setPublishingTask(false);
    }
  }

  async function handleDeleteDetailTask() {
    if (route.kind !== "detail") {
      return;
    }
    setDeletingTask(true);
    setTaskActionError(null);
    try {
      await deleteTask(route.taskId);
      await loadTasksData();
      setRoute({ kind: "overview" });
      setTaskDetail(null);
      setTaskDraft(createBlankTaskDraft());
      setCommentDraft(createBlankCommentDraft());
      setFileReferenceDraft(createBlankFileReferenceDraft());
      setTaskDraftDirty(false);
      setSelectedBlockerTaskId("");
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to delete task.");
    } finally {
      setDeletingTask(false);
    }
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

  async function handleAddComment(draft: TaskCommentInput) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await commentOnTask(route.taskId, draft);
      if (!draft.parentCommentId) {
        setCommentDraft(createBlankCommentDraft());
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add comment.");
    }
  }

  async function handleDispatchTaskLane() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await dispatchTaskLane(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to dispatch task lane.");
    }
  }

  async function handleCompleteLane(outcome: "success" | "failure" | "needs_user") {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      if (outcome === "success") {
        await completeLaneAsSuccess(route.taskId);
      } else if (outcome === "failure") {
        await completeLaneAsFailure(route.taskId);
      } else {
        await requestUserIntervention(route.taskId);
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to complete task lane.");
    }
  }

  async function handleApproveLaneCompletion() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await approveLaneCompletion(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to approve task lane.");
    }
  }

  async function handleSendLaneBackForWork() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await sendLaneBackForWork(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to send task lane back for work.");
    }
  }

  async function handlePauseTaskRuntime() {
    if (route.kind !== "detail" || !taskDetail?.activeLaneAssignment?.sessionId) {
      return;
    }
    setTaskActionError(null);
    try {
      await stopSessionRuntime(taskDetail.activeLaneAssignment.sessionId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to pause task runtime.");
    }
  }

  async function handleWhipTask() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
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
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to send manual task whip.");
    }
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
          onViewModeChange={handleTaskBoardViewModeChange}
          roles={roles}
          viewMode={taskBoardViewMode}
        />
      ) : route.kind === "create" ? (
        <TaskCreatePage
          agents={agents}
          draft={taskDraft}
          onBack={() => setRoute({ kind: "overview" })}
          onChange={(draft) => {
            setTaskDraft(draft);
            setTaskDraftDirty(true);
          }}
          onPublish={() => void handlePublishCreateTask()}
          onSave={() => void handleSaveCreateTask()}
          repositories={repositories}
          roles={roles}
          saving={savingTask || publishingTask}
          workflows={workflowSummaries}
        />
      ) : taskDetail ? (
        <TaskDetailPage
          agents={agents}
          commentDraft={commentDraft}
          deleting={deletingTask}
          dependencyCandidates={dependencyCandidates.map((task) => ({ id: task.id, number: task.number, title: task.title }))}
          draft={taskDraft}
          fileReferenceDraft={fileReferenceDraft}
          loading={loadingTaskDetail}
          onAddAttachment={(files) => void handleAttachmentInputChange(files)}
          onAddComment={(draft) => handleAddComment(draft)}
          onAddDependency={() => void handleAddDependency()}
          onAddFileReference={() => void handleAddFileReference()}
          onApproveCompletion={() => void handleApproveLaneCompletion()}
          onBack={() => setRoute({ kind: "overview" })}
          onCommentDraftChange={setCommentDraft}
          onComplete={(outcome) => void handleCompleteLane(outcome)}
          onDelete={() => void handleDeleteDetailTask()}
          onDispatch={() => void handleDispatchTaskLane()}
          onDraftChange={(draft) => {
            setTaskDraft(draft);
            setTaskDraftDirty(true);
          }}
          onFileReferenceDraftChange={setFileReferenceDraft}
          onOpenTask={openTaskDetail}
          onPublish={() => void handlePublishDetailTask()}
          onRemoveAttachment={(attachmentId) => void handleRemoveAttachment(attachmentId)}
          onRetry={() => void handleRetryTaskLane()}
          onPauseRuntime={() => void handlePauseTaskRuntime()}
          onWhipTask={() => void handleWhipTask()}
          onSendBackForWork={() => void handleSendLaneBackForWork()}
          onRemoveDependency={(dependencyId) => void handleRemoveDependency(dependencyId)}
          onRemoveFileReference={(referenceId) => void handleRemoveFileReference(referenceId)}
          onSetDefaultFileReference={(referenceId) => void handleSetDefaultFileReference(referenceId)}
          onSave={() => void handleSaveDetailTask()}
          onSelectBlocker={setSelectedBlockerTaskId}
          publishing={publishingTask}
          roles={roles}
          repositories={repositories}
          saving={savingTask}
          selectedBlockerTaskId={selectedBlockerTaskId}
          task={taskDetail}
          timelineItems={timelineItems}
          workflows={workflowSummaries}
        />
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
