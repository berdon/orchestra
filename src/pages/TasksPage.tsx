import { useEffect, useMemo, useRef, useState } from "react";

import { listAgents } from "../lib/agents";
import { listRoles } from "../lib/roles";
import {
  addTaskAttachment,
  addTaskDependency,
  commentOnTask,
  completeLaneAsFailure,
  completeLaneAsSuccess,
  createTask,
  dispatchTaskLane,
  getTask,
  getWorkflow,
  listTasks,
  listWorkflows,
  removeTaskAttachment,
  removeTaskDependency,
  requestUserIntervention,
  updateTask,
} from "../lib/tauri";
import type {
  AgentSummary,
  RoleSummary,
  TaskCommentInput,
  TaskDetail,
  TaskSummary,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowSummary,
} from "../types";
import { TaskCreatePage } from "./tasks/TaskCreatePage";
import { TaskDetailPage } from "./tasks/TaskDetailPage";
import { buildTaskBoardModel, isDraftTask, type TaskBoardModel } from "./tasks/taskBoardModel";
import { TasksOverviewPage, type TaskBoardFilter } from "./tasks/TasksOverviewPage";

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
    parentTaskId: null,
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
    parentTaskId: task.parentTaskId ?? null,
    archived: task.archived,
  };
}

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

interface TasksPageProps {
  createTaskToken?: number;
}

function sameData<T>(current: T, next: T) {
  return JSON.stringify(current) === JSON.stringify(next);
}

export function TasksPage({ createTaskToken = 0 }: TasksPageProps) {
  const [route, setRoute] = useState<TasksRoute>({ kind: "overview" });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [workflowSummaries, setWorkflowSummaries] = useState<WorkflowSummary[]>([]);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<Record<string, WorkflowDefinition>>({});
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskUpsertInput>(createBlankTaskDraft);
  const [commentDraft, setCommentDraft] = useState<TaskCommentInput>(createBlankCommentDraft);
  const [taskDraftDirty, setTaskDraftDirty] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [includeArchivedTasks, setIncludeArchivedTasks] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskBoardFilter>("all");
  const [selectedBlockerTaskId, setSelectedBlockerTaskId] = useState("");
  const createTaskTokenRef = useRef(createTaskToken);

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
      title: `${comment.author} commented`,
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

    return [...comments, ...attachments, ...laneRuns, ...blockedBy, ...blocking].sort(
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
      const [nextTasks, nextWorkflows, nextAgents, nextRoles] = await Promise.all([
        listTasks(includeArchivedTasks),
        listWorkflows(false),
        listAgents(false),
        listRoles(false),
      ]);
      setTasks((current) => (sameData(current, nextTasks) ? current : nextTasks));
      setWorkflowSummaries((current) => (sameData(current, nextWorkflows) ? current : nextWorkflows));
      setAgents((current) => (sameData(current, nextAgents) ? current : nextAgents));
      setRoles((current) => (sameData(current, nextRoles) ? current : nextRoles));

      const workflowIds = Array.from(new Set(nextTasks.filter((task) => task.workflowId && !isDraftTask(task)).map((task) => task.workflowId!)));
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
  }, [includeArchivedTasks]);

  useEffect(() => {
    if (route.kind === "detail") {
      void loadTaskDetail(route.taskId, { preserveDraft: taskDraftDirty });
    }
  }, [route.kind === "detail" ? route.taskId : null]);

  useEffect(() => {
    if (route.kind === "create" || taskDraftDirty) {
      return;
    }

    const refresh = () => {
      void loadTasksData({ silent: true });
      if (route.kind === "detail") {
        void loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
      }
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, 10000);

    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [route, taskDraftDirty, includeArchivedTasks]);

  useEffect(() => {
    if (createTaskToken === createTaskTokenRef.current) {
      return;
    }

    createTaskTokenRef.current = createTaskToken;
    openCreateTask();
  }, [createTaskToken]);

  function openCreateTask(parentTaskId?: string | null, workflowId?: string | null) {
    setTaskDraft({
      ...createBlankTaskDraft(),
      parentTaskId: parentTaskId ?? null,
      workflowId: workflowId ?? null,
    });
    setCommentDraft(createBlankCommentDraft());
    setTaskDraftDirty(false);
    setRoute({ kind: "create", parentTaskId: parentTaskId ?? null, workflowId: workflowId ?? null });
  }

  function openTaskDetail(taskId: string) {
    setRoute({ kind: "detail", taskId });
  }

  async function handleSaveCreateTask() {
    setSavingTask(true);
    setTaskActionError(null);
    try {
      const saved = await createTask(taskDraft);
      await loadTasksData();
      setRoute({ kind: "detail", taskId: saved.id });
      await loadTaskDetail(saved.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to create task.");
    } finally {
      setSavingTask(false);
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

  async function handleAddComment() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await commentOnTask(route.taskId, commentDraft);
      setCommentDraft(createBlankCommentDraft());
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
          includeArchived={includeArchivedTasks}
          onFilterChange={setTaskFilter}
          onIncludeArchivedChange={setIncludeArchivedTasks}
          onOpenTask={openTaskDetail}
          roles={roles}
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
          onSave={() => void handleSaveCreateTask()}
          roles={roles}
          saving={savingTask}
          workflows={workflowSummaries}
        />
      ) : taskDetail ? (
        <TaskDetailPage
          agents={agents}
          commentDraft={commentDraft}
          dependencyCandidates={dependencyCandidates.map((task) => ({ id: task.id, number: task.number, title: task.title }))}
          draft={taskDraft}
          loading={loadingTaskDetail}
          onAddAttachment={(files) => void handleAttachmentInputChange(files)}
          onAddComment={() => void handleAddComment()}
          onAddDependency={() => void handleAddDependency()}
          onBack={() => setRoute({ kind: "overview" })}
          onCommentDraftChange={setCommentDraft}
          onComplete={(outcome) => void handleCompleteLane(outcome)}
          onCreateSubtask={() => openCreateTask(taskDetail.id, taskDetail.workflowId ?? null)}
          onDispatch={() => void handleDispatchTaskLane()}
          onDraftChange={(draft) => {
            setTaskDraft(draft);
            setTaskDraftDirty(true);
          }}
          onOpenTask={openTaskDetail}
          onRemoveAttachment={(attachmentId) => void handleRemoveAttachment(attachmentId)}
          onRemoveDependency={(dependencyId) => void handleRemoveDependency(dependencyId)}
          onSave={() => void handleSaveDetailTask()}
          onSelectBlocker={setSelectedBlockerTaskId}
          roles={roles}
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
