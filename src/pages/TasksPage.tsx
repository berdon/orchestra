import { useEffect, useMemo, useState } from "react";

import { listAgents } from "../lib/agents";
import { listRoles } from "../lib/roles";
import { addTaskAttachment, addTaskDependency, commentOnTask, completeLaneAsFailure, completeLaneAsSuccess, createTask, dispatchTaskLane, getTask, listTasks, listWorkflows, removeTaskAttachment, removeTaskDependency, requestUserIntervention, updateTask } from "../lib/tauri";
import type { AgentSummary, RoleSummary, TaskCommentInput, TaskDetail, TaskPriority, TaskStatus, TaskSummary, TaskType, TaskUpsertInput, WorkflowSummary } from "../types";

const TASK_TYPES: TaskType[] = ["task", "bug", "feature", "chore", "epic"];
const TASK_STATUSES: TaskStatus[] = ["draft", "ready", "in_progress", "blocked", "in_review", "completed", "canceled"];
const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];

type TaskNavView = "all" | "attention" | "review" | "blocked" | "active" | "epics";

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
    type: (task.type as TaskType) ?? "task",
    status: (task.status as TaskStatus) ?? "draft",
    priority: (task.priority as TaskPriority) ?? "P2",
    workflowId: task.workflowId ?? null,
    currentLaneId: task.currentLaneId ?? null,
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId ?? null,
    repositoryId: task.repositoryId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    archived: task.archived,
  };
}

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function getStatusTone(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "blocked":
      return "error";
    case "in_review":
      return "warning";
    case "in_progress":
      return "accent";
    default:
      return "neutral";
  }
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskUpsertInput>(createBlankTaskDraft);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [includeArchivedTasks, setIncludeArchivedTasks] = useState(false);
  const [taskNavView, setTaskNavView] = useState<TaskNavView>("all");
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [selectedBlockerTaskId, setSelectedBlockerTaskId] = useState<string>("");
  const [commentDraft, setCommentDraft] = useState<TaskCommentInput>(createBlankCommentDraft);

  const attentionTasks = useMemo(
    () => tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked),
    [tasks],
  );

  const filteredTasks = useMemo(() => {
    switch (taskNavView) {
      case "attention":
        return attentionTasks;
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
  }, [attentionTasks, taskNavView, tasks]);

  const selectedTaskSummary = useMemo(
    () => filteredTasks.find((task) => task.id === selectedTaskId) ?? filteredTasks[0] ?? null,
    [filteredTasks, selectedTaskId],
  );

  const workflowLabelMap = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows],
  );

  const dependencyCandidates = useMemo(
    () => tasks.filter((task) => task.id !== selectedTaskSummary?.id),
    [selectedTaskSummary?.id, tasks],
  );

  const availableAssignees = useMemo(() => {
    if (taskDraft.assigneeType === "agent") {
      return agents.map((agent) => ({ value: agent.slug, label: agent.name }));
    }

    if (taskDraft.assigneeType === "role") {
      return roles.map((role) => ({ value: role.slug, label: role.name }));
    }

    return [];
  }, [agents, roles, taskDraft.assigneeType]);

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

  async function loadTasks() {
    setLoadingTasks(true);
    setTaskActionError(null);

    try {
      const nextTasks = await listTasks(includeArchivedTasks);
      setTasks(nextTasks);
      setSelectedTaskId((current) => {
        if (isCreatingTask) {
          return current;
        }

        if (current && nextTasks.some((task) => task.id === current)) {
          return current;
        }

        return nextTasks[0]?.id ?? null;
      });
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to load tasks.");
    } finally {
      setLoadingTasks(false);
    }
  }

  async function loadTaskDetail(taskId: string) {
    setLoadingTaskDetail(true);
    setTaskActionError(null);

    try {
      const task = await getTask(taskId);
      setTaskDetail(task);
      setTaskDraft(taskToDraft(task));
      setCommentDraft(createBlankCommentDraft());
      setLoadedTaskId(task.id);
      setIsCreatingTask(false);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to load task.");
    } finally {
      setLoadingTaskDetail(false);
    }
  }

  async function loadWorkflowsForTasks() {
    try {
      setWorkflows(await listWorkflows(false));
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to load workflows.");
    }
  }

  async function loadWorkersForTasks() {
    try {
      const [nextAgents, nextRoles] = await Promise.all([listAgents(false), listRoles(false)]);
      setAgents(nextAgents);
      setRoles(nextRoles);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to load available workers.");
    }
  }

  function beginCreateTask() {
    setTaskActionError(null);
    setTaskDetail(null);
    setTaskDraft(createBlankTaskDraft());
    setCommentDraft(createBlankCommentDraft());
    setLoadedTaskId(null);
    setIsCreatingTask(true);
  }

  function beginCreateSubtask() {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    setTaskDetail(null);
    setTaskDraft({
      ...createBlankTaskDraft(),
      workflowId: taskDetail?.workflowId ?? selectedTaskSummary.workflowId ?? null,
      parentTaskId: selectedTaskSummary.id,
    });
    setCommentDraft(createBlankCommentDraft());
    setLoadedTaskId(null);
    setIsCreatingTask(true);
  }

  async function handleSaveTask() {
    setSavingTask(true);
    setTaskActionError(null);

    try {
      const saved = isCreatingTask || !loadedTaskId ? await createTask(taskDraft) : await updateTask(loadedTaskId, taskDraft);
      await loadTasks();
      setSelectedTaskId(saved.id);
      await loadTaskDetail(saved.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to save task.");
    } finally {
      setSavingTask(false);
    }
  }

  async function handleAddDependency() {
    if (!selectedTaskSummary || !selectedBlockerTaskId) {
      return;
    }

    setTaskActionError(null);
    try {
      await addTaskDependency(selectedBlockerTaskId, selectedTaskSummary.id);
      setSelectedBlockerTaskId("");
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add dependency.");
    }
  }

  async function handleRemoveDependency(dependencyId: string) {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    try {
      await removeTaskDependency(dependencyId);
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to remove dependency.");
    }
  }

  async function handleAttachmentInputChange(fileList: FileList | null) {
    if (!selectedTaskSummary || !fileList?.length) {
      return;
    }

    setTaskActionError(null);
    try {
      for (const file of Array.from(fileList)) {
        const base64Data = await readFileAsBase64(file);
        await addTaskAttachment(selectedTaskSummary.id, {
          fileName: file.name,
          mediaType: file.type || "application/octet-stream",
          base64Data,
          caption: null,
        });
      }
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add attachment.");
    }
  }

  async function handleRemoveAttachment(attachmentId: string) {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    try {
      await removeTaskAttachment(attachmentId);
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to remove attachment.");
    }
  }

  async function handleAddComment() {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    try {
      await commentOnTask(selectedTaskSummary.id, commentDraft);
      setCommentDraft(createBlankCommentDraft());
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to add comment.");
    }
  }

  async function handleDispatchTaskLane() {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    try {
      await dispatchTaskLane(selectedTaskSummary.id);
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to dispatch task lane.");
    }
  }

  async function handleCompleteLane(outcome: "success" | "failure" | "needs_user") {
    if (!selectedTaskSummary) {
      return;
    }

    setTaskActionError(null);
    try {
      if (outcome === "success") {
        await completeLaneAsSuccess(selectedTaskSummary.id);
      } else if (outcome === "failure") {
        await completeLaneAsFailure(selectedTaskSummary.id);
      } else {
        await requestUserIntervention(selectedTaskSummary.id);
      }
      await loadTasks();
      await loadTaskDetail(selectedTaskSummary.id);
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Unable to complete task lane.");
    }
  }

  useEffect(() => {
    void loadTasks();
  }, [includeArchivedTasks]);

  useEffect(() => {
    void loadWorkflowsForTasks();
    void loadWorkersForTasks();
  }, []);

  useEffect(() => {
    if (!selectedTaskSummary || isCreatingTask) {
      return;
    }

    if (selectedTaskSummary.id !== loadedTaskId) {
      void loadTaskDetail(selectedTaskSummary.id);
    }
  }, [isCreatingTask, loadedTaskId, selectedTaskSummary?.id]);

  return (
    <section className="task-shell">
      <aside className="task-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Workflow operations</p>
            <h3>Tasks</h3>
          </div>
          <div className="action-cluster">
            <label className="checkbox-row">
              <input type="checkbox" checked={includeArchivedTasks} onChange={(event) => setIncludeArchivedTasks(event.target.checked)} />
              Show archived
            </label>
            <button className="primary-button" data-role="new-task" type="button" onClick={beginCreateTask}>
              New task
            </button>
          </div>
        </div>

        {loadingTasks ? <p className="muted-copy">Loading tasks…</p> : null}
        {taskActionError ? <p className="error-copy">{taskActionError}</p> : null}

        <div className="task-nav-filters" data-role="task-nav-filters">
          {([
            ["all", "All", tasks.length],
            ["attention", "Attention", attentionTasks.length],
            ["review", "Needs review", tasks.filter((task) => task.status === "in_review").length],
            ["blocked", "Blocked", tasks.filter((task) => task.status === "blocked" || task.dependencyBlocked).length],
            ["active", "Active", tasks.filter((task) => task.status === "in_progress" || task.readyForDispatch).length],
            ["epics", "Epics", tasks.filter((task) => task.type === "epic").length],
          ] as Array<[TaskNavView, string, number]>).map(([view, label, count]) => (
            <button
              key={view}
              className={taskNavView === view ? "task-nav-filter task-nav-filter--active" : "task-nav-filter"}
              data-role={`task-filter-${view}`}
              type="button"
              onClick={() => setTaskNavView(view)}
            >
              <span>{label}</span>
              <span>{count}</span>
            </button>
          ))}
        </div>

        <section className="task-section task-section--compact task-attention-queue">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Inbox</p>
              <h4>Needs attention</h4>
            </div>
            <button className="secondary-button" type="button" onClick={() => setTaskNavView("attention")}>
              Open queue
            </button>
          </div>

          {attentionTasks.length === 0 ? <p className="muted-copy">No review or blocked tasks right now.</p> : null}
          <div className="task-section-list" data-role="task-attention-queue">
            {attentionTasks.slice(0, 4).map((task) => (
              <button
                className="task-child-card"
                key={task.id}
                type="button"
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setIsCreatingTask(false);
                  setTaskNavView("attention");
                }}
              >
                <div className="workflow-section__header">
                  <strong>{task.number} · {task.title}</strong>
                  <span className={`status-badge status-badge--${task.status === "blocked" || task.dependencyBlocked ? "error" : "warning"}`}>
                    {task.status === "blocked" || task.dependencyBlocked ? "blocked" : "review"}
                  </span>
                </div>
                <p className="muted-copy">
                  {task.dependencyBlocked ? "Blocked by dependency" : task.status === "in_review" ? "Waiting on user review" : "Needs attention"}
                </p>
              </button>
            ))}
          </div>
        </section>

        <nav className="task-list" aria-label="Tasks">
          {filteredTasks.map((task) => (
            <a
              key={task.id}
              className={task.id === selectedTaskSummary?.id && !isCreatingTask ? "task-list-link task-list-link--active" : "task-list-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedTaskId(task.id);
                setIsCreatingTask(false);
              }}
            >
              <span className="task-list-link__eyebrow">{task.number}</span>
              <strong>{task.title}</strong>
              <span className="task-list-link__meta">
                <span>{formatStatusLabel(task.status)}</span>
                <span>{task.priority}</span>
                <span>{task.type}</span>
                {task.childCount ? <span>{task.childCount} children</span> : null}
                {task.attachmentCount ? <span>{task.attachmentCount} attachments</span> : null}
                {task.dependencyBlocked ? <span>dependency blocked</span> : null}
              </span>
            </a>
          ))}
        </nav>
      </aside>

      <section className="panel task-detail-panel">
        {selectedTaskSummary || isCreatingTask ? (
          <div className="task-detail-stack">
            <div className="panel__header panel__header--session-detail">
              <div>
                <p className="eyebrow">Task detail</p>
                <h3 data-role="task-title-heading">{isCreatingTask ? "New task" : taskDraft.title.trim() || selectedTaskSummary?.title || "Untitled task"}</h3>
                {!isCreatingTask && selectedTaskSummary ? (
                  <div className="session-detail__meta">
                    <span>{selectedTaskSummary.number}</span>
                    <span>{workflowLabelMap.get(selectedTaskSummary.workflowId ?? "") ?? "No workflow"}</span>
                    <span>{selectedTaskSummary.commentCount} comments</span>
                    <span>{selectedTaskSummary.laneRunCount} lane runs</span>
                    {selectedTaskSummary.childCount ? <span>{selectedTaskSummary.childCount} children</span> : null}
                    {selectedTaskSummary.attachmentCount ? <span>{selectedTaskSummary.attachmentCount} attachments</span> : null}
                    {selectedTaskSummary.blockedByCount ? <span>{selectedTaskSummary.blockedByCount} blockers</span> : null}
                    <span>{selectedTaskSummary.readyForDispatch ? "Dispatchable" : "Not dispatchable"}</span>
                  </div>
                ) : (
                  <div className="session-detail__meta">
                    <span>Create a workflow-driven task record for Orchestra.</span>
                  </div>
                )}
              </div>

              <div className="action-cluster">
                {!isCreatingTask && selectedTaskSummary ? (
                  <>
                    <button className="secondary-button" data-role="new-subtask" type="button" onClick={beginCreateSubtask}>
                      New subtask
                    </button>
                    {selectedTaskSummary.dependencyBlocked ? <span className="status-badge status-badge--error">Dependency blocked</span> : null}
                    <span className={`status-badge status-badge--${getStatusTone(selectedTaskSummary.status)}`}>{formatStatusLabel(selectedTaskSummary.status)}</span>
                  </>
                ) : null}
                <button className="primary-button" data-role="save-task" type="button" disabled={savingTask || loadingTaskDetail} onClick={() => void handleSaveTask()}>
                  {savingTask ? "Saving…" : isCreatingTask ? "Create task" : "Save changes"}
                </button>
              </div>
            </div>

            <div className="task-editor-grid">
              <label className="field-group">
                <span className="field-group__label">Title</span>
                <input
                  className="text-input"
                  data-role="task-title"
                  value={taskDraft.title}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </label>

              <label className="field-group">
                <span className="field-group__label">Type</span>
                <select
                  className="select-input"
                  data-role="task-type"
                  value={taskDraft.type}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, type: event.target.value as TaskType }))}
                >
                  {TASK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-group">
                <span className="field-group__label">Status</span>
                <select
                  className="select-input"
                  data-role="task-status"
                  value={taskDraft.status}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                >
                  {TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {formatStatusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-group">
                <span className="field-group__label">Priority</span>
                <select
                  className="select-input"
                  data-role="task-priority"
                  value={taskDraft.priority}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, priority: event.target.value as TaskPriority }))}
                >
                  {TASK_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-group">
                <span className="field-group__label">Workflow</span>
                <select
                  className="select-input"
                  data-role="task-workflow"
                  value={taskDraft.workflowId ?? ""}
                  onChange={(event) =>
                    setTaskDraft((current) => ({
                      ...current,
                      workflowId: event.target.value || null,
                      currentLaneId: null,
                    }))
                  }
                >
                  <option value="">No workflow selected</option>
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-group">
                <span className="field-group__label">Assignee type</span>
                <select
                  className="select-input"
                  data-role="task-assignee-type"
                  value={taskDraft.assigneeType}
                  onChange={(event) =>
                    setTaskDraft((current) => ({
                      ...current,
                      assigneeType: event.target.value,
                      assigneeId: null,
                    }))
                  }
                >
                  <option value="unassigned">unassigned</option>
                  <option value="user">user</option>
                  <option value="agent">agent</option>
                  <option value="role">role</option>
                </select>
              </label>

              {taskDraft.assigneeType === "agent" || taskDraft.assigneeType === "role" ? (
                <label className="field-group task-editor-grid__full">
                  <span className="field-group__label">{taskDraft.assigneeType === "agent" ? "Agent" : "Role"}</span>
                  <select
                    className="select-input"
                    data-role="task-assignee-id"
                    value={taskDraft.assigneeId ?? ""}
                    onChange={(event) => setTaskDraft((current) => ({ ...current, assigneeId: event.target.value || null }))}
                  >
                    <option value="">Select a {taskDraft.assigneeType}</option>
                    {availableAssignees.map((assignee) => (
                      <option key={assignee.value} value={assignee.value}>
                        {assignee.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Description</span>
                <textarea
                  className="text-area"
                  data-role="task-description"
                  rows={6}
                  value={taskDraft.description ?? ""}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
            </div>

            <div className="task-detail-sections">
              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Runtime</p>
                    <h4>Lane execution</h4>
                  </div>
                  {!isCreatingTask && selectedTaskSummary ? (
                    <div className="action-cluster">
                      {selectedTaskSummary.readyForDispatch ? (
                        <button className="primary-button" data-role="dispatch-task-lane" type="button" onClick={() => void handleDispatchTaskLane()}>
                          Dispatch lane
                        </button>
                      ) : null}
                      {taskDetail?.activeLaneAssignment || (taskDetail?.workflowId && taskDetail?.currentLaneId && taskDetail.assigneeType === "user") ? (
                        <>
                          <button className="secondary-button" data-role="complete-task-success" type="button" onClick={() => void handleCompleteLane("success")}>
                            Mark success
                          </button>
                          <button className="secondary-button secondary-button--danger" data-role="complete-task-failure" type="button" onClick={() => void handleCompleteLane("failure")}>
                            Mark failure
                          </button>
                          <button className="secondary-button" data-role="complete-task-needs-user" type="button" onClick={() => void handleCompleteLane("needs_user")}>
                            Needs user
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {taskDetail?.activeLaneAssignment ? (
                  <div className="task-runtime-card" data-role="task-runtime-assignment">
                    <div className="workflow-section__header">
                      <strong>{taskDetail.activeLaneAssignment.workerType} · {taskDetail.activeLaneAssignment.workerId ?? "unassigned"}</strong>
                      <span className={`status-badge status-badge--${taskDetail.activeLaneAssignment.status === "active" ? "success" : taskDetail.activeLaneAssignment.status === "queued" ? "warning" : "neutral"}`}>
                        {taskDetail.activeLaneAssignment.status}
                      </span>
                    </div>
                    <div className="workforce-meta-grid muted-copy">
                      <span>Lane: {taskDetail.activeLaneAssignment.laneId}</span>
                      <span>Session: {taskDetail.activeLaneAssignment.sessionId ?? "—"}</span>
                      <span>Runtime cwd: {taskDetail.activeLaneAssignment.runtimeCwd ?? "—"}</span>
                    </div>
                  </div>
                ) : (
                  <p className="muted-copy">
                    {selectedTaskSummary?.readyForDispatch
                      ? "This lane is ready to dispatch into the assigned workflow worker."
                      : "No active runtime assignment. User-owned lanes and blocked tasks stay here until they are actionable."}
                  </p>
                )}
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Hierarchy</p>
                    <h4>Lineage and rollups</h4>
                  </div>
                </div>

                {taskDraft.parentTaskId && taskDetail?.lineage.length ? (
                  <div className="task-lineage" data-role="task-lineage">
                    {taskDetail.lineage.map((ancestor) => (
                      <button
                        className="task-lineage__crumb"
                        key={ancestor.id}
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(ancestor.id);
                          setIsCreatingTask(false);
                        }}
                      >
                        {ancestor.number} · {ancestor.title}
                      </button>
                    ))}
                    {taskDetail.parent ? <span className="task-lineage__current">Parent: {taskDetail.parent.number}</span> : null}
                  </div>
                ) : (
                  <p className="muted-copy">No parent task. This task is currently a top-level item.</p>
                )}

                {taskDetail?.childCount ? (
                  <div className="task-rollup-grid">
                    <article className="status-card">
                      <span className="status-card__label">Children</span>
                      <strong>{taskDetail.childCount}</strong>
                    </article>
                    <article className="status-card">
                      <span className="status-card__label">In progress</span>
                      <strong>{taskDetail.inProgressChildCount}</strong>
                    </article>
                    <article className="status-card">
                      <span className="status-card__label">Blocked</span>
                      <strong>{taskDetail.blockedChildCount}</strong>
                    </article>
                    <article className="status-card">
                      <span className="status-card__label">Completed</span>
                      <strong>{taskDetail.completedChildCount}</strong>
                    </article>
                  </div>
                ) : null}

                {taskDetail?.children.length ? (
                  <div className="task-section-list" data-role="task-children">
                    {taskDetail.children.map((child) => (
                      <button
                        className="task-child-card"
                        key={child.id}
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(child.id);
                          setIsCreatingTask(false);
                        }}
                      >
                        <div className="workflow-section__header">
                          <strong>{child.number} · {child.title}</strong>
                          <span className={`status-badge status-badge--${getStatusTone(child.status)}`}>{formatStatusLabel(child.status)}</span>
                        </div>
                        <p className="muted-copy">{child.type} · {child.priority}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No child tasks yet. Use “New subtask” to break work down under this task.</p>
                )}
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Dependencies</p>
                    <h4>Blocked by and blocking</h4>
                  </div>
                  {!isCreatingTask && selectedTaskSummary ? (
                    <div className="task-dependency-actions">
                      <select className="select-input" data-role="dependency-blocker-select" value={selectedBlockerTaskId} onChange={(event) => setSelectedBlockerTaskId(event.target.value)}>
                        <option value="">Select blocker task…</option>
                        {dependencyCandidates.map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.number} · {task.title}
                          </option>
                        ))}
                      </select>
                      <button className="secondary-button" data-role="add-dependency" type="button" disabled={!selectedBlockerTaskId} onClick={() => void handleAddDependency()}>
                        Add dependency
                      </button>
                    </div>
                  ) : null}
                </div>

                {taskDetail?.dependencyBlocked ? <p className="error-copy">This task is currently blocked by unresolved dependencies and is not dispatchable.</p> : null}

                <div className="task-dependency-grid">
                  <div className="task-dependency-column">
                    <p className="eyebrow">Blocked by</p>
                    {taskDetail?.blockedBy.length ? (
                      <div className="task-section-list" data-role="task-blocked-by">
                        {taskDetail.blockedBy.map((dependency) => (
                          <article className="task-history-card" key={dependency.id}>
                            <div className="workflow-section__header">
                              <strong>{dependency.blocker.number} · {dependency.blocker.title}</strong>
                              <span className={`status-badge status-badge--${getStatusTone(dependency.blocker.status)}`}>{formatStatusLabel(dependency.blocker.status)}</span>
                            </div>
                            <p className="muted-copy">{dependency.blocker.priority} · {dependency.blocker.type}</p>
                            <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleRemoveDependency(dependency.id)}>
                              Remove dependency
                            </button>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="muted-copy">No blockers. This task can proceed unless workflow state says otherwise.</p>
                    )}
                  </div>

                  <div className="task-dependency-column">
                    <p className="eyebrow">Blocking</p>
                    {taskDetail?.blocking.length ? (
                      <div className="task-section-list" data-role="task-blocking">
                        {taskDetail.blocking.map((dependency) => (
                          <article className="task-history-card" key={dependency.id}>
                            <div className="workflow-section__header">
                              <strong>{dependency.blocked.number} · {dependency.blocked.title}</strong>
                              <span className={`status-badge status-badge--${getStatusTone(dependency.blocked.status)}`}>{formatStatusLabel(dependency.blocked.status)}</span>
                            </div>
                            <p className="muted-copy">This task will stay blocked until the current task is resolved.</p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="muted-copy">No downstream blocked tasks yet.</p>
                    )}
                  </div>
                </div>
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Attachments</p>
                    <h4>Task materials</h4>
                  </div>
                  {!isCreatingTask && selectedTaskSummary ? (
                    <label className="secondary-button task-attachment-upload">
                      <input
                        data-role="task-attachment-input"
                        type="file"
                        multiple
                        onChange={(event) => void handleAttachmentInputChange(event.target.files)}
                      />
                      Add attachment
                    </label>
                  ) : null}
                </div>

                {taskDetail?.attachments.length ? (
                  <div className="task-attachment-grid" data-role="task-attachments">
                    {taskDetail.attachments.map((attachment) => (
                      <article className="task-attachment-card" key={attachment.id}>
                        <div className="workflow-section__header">
                          <strong>{attachment.fileName}</strong>
                          <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleRemoveAttachment(attachment.id)}>
                            Remove
                          </button>
                        </div>
                        <p className="muted-copy">
                          {attachment.mediaType} · {Math.max(1, Math.round(attachment.byteSize / 1024))} KB
                        </p>
                        {attachment.caption ? <p>{attachment.caption}</p> : null}
                        {attachment.imageDataUrl ? <img alt={attachment.fileName} className="task-attachment-card__image" src={attachment.imageDataUrl} /> : null}
                        {attachment.previewText ? <pre className="task-attachment-card__text">{attachment.previewText}</pre> : null}
                        <p className="muted-copy">{attachment.storedPath}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No attachments yet. Upload text or image files to give agents richer task context.</p>
                )}
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Comments</p>
                    <h4>Task conversation</h4>
                  </div>
                </div>

                {!isCreatingTask && selectedTaskSummary ? (
                  <div className="task-comment-composer">
                    <div className="task-comment-composer__grid">
                      <label className="field-group">
                        <span className="field-group__label">Author</span>
                        <input
                          className="text-input"
                          data-role="task-comment-author"
                          value={commentDraft.author}
                          onChange={(event) => setCommentDraft((current) => ({ ...current, author: event.target.value }))}
                        />
                      </label>
                      <label className="checkbox-row task-comment-composer__interrupt">
                        <input
                          data-role="task-comment-interrupt"
                          type="checkbox"
                          checked={commentDraft.interruptAgent}
                          onChange={(event) => setCommentDraft((current) => ({ ...current, interruptAgent: event.target.checked }))}
                        />
                        Interrupt current worker now
                      </label>
                    </div>
                    <label className="field-group">
                      <span className="field-group__label">Add comment</span>
                      <textarea
                        className="text-area"
                        data-role="task-comment-message"
                        rows={4}
                        value={commentDraft.message}
                        onChange={(event) => setCommentDraft((current) => ({ ...current, message: event.target.value }))}
                      />
                    </label>
                    <div className="task-comment-composer__actions">
                      <button className="primary-button" data-role="add-task-comment" type="button" onClick={() => void handleAddComment()}>
                        Add comment
                      </button>
                    </div>
                  </div>
                ) : null}

                {taskDetail?.comments.length ? (
                  <div className="task-section-list" data-role="task-comments">
                    {taskDetail.comments.map((comment) => (
                      <article className="transcript-event transcript-event--system" key={comment.id}>
                        <div className="transcript-event__meta">
                          <span>{comment.author}</span>
                          <div className="transcript-event__meta-group">
                            {comment.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
                            <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
                          </div>
                        </div>
                        <p>{comment.message}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No comments yet. Add one to capture guidance, review notes, or an interrupt request.</p>
                )}
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Timeline</p>
                    <h4>Task activity</h4>
                  </div>
                </div>

                {timelineItems.length ? (
                  <div className="task-timeline" data-role="task-timeline">
                    {timelineItems.map((item) => (
                      <article className="task-timeline-item" key={item.id}>
                        <div className="workflow-section__header">
                          <strong>{item.title}</strong>
                          <span className={`status-badge status-badge--${item.tone}`}>{item.kind.replace(/_/g, " ")}</span>
                        </div>
                        <p>{item.description}</p>
                        <p className="muted-copy">{new Date(item.timestamp).toLocaleString()}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No activity recorded yet.</p>
                )}
              </section>

              <section className="task-section">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Lane history</p>
                    <h4>Execution continuity</h4>
                  </div>
                </div>

                {taskDetail?.laneRuns.length ? (
                  <div className="task-section-list">
                    {taskDetail.laneRuns.map((laneRun) => (
                      <article className="task-history-card" key={laneRun.id}>
                        <div className="workflow-section__header">
                          <strong>{laneRun.laneId}</strong>
                          <span className={`status-badge status-badge--${laneRun.result === "success" ? "success" : laneRun.result === "failure" ? "error" : "neutral"}`}>
                            {laneRun.result.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="muted-copy">Session {laneRun.sessionId}</p>
                        {laneRun.notes ? <p>{laneRun.notes}</p> : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No lane runs recorded yet.</p>
                )}
              </section>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No task selected</p>
            <h3>Create or select a task</h3>
            <p>The first task slice gives Orchestra a persisted task list and detail shell for workflow execution.</p>
          </div>
        )}
      </section>
    </section>
  );
}
