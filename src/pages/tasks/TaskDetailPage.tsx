import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import hljs from "highlight.js";
import type { AgentSummary, MailboxMessage, RepositoryRecord, RoleSummary, TaskComment, TaskCommentInput, TaskDetail, TaskFileReference, TaskFileReferenceInput, TaskUpsertInput, WorkflowSummary } from "../../types";
import { getTaskFileContent } from "../../lib/tauri";
import { TaskActionMenu, type TaskActionMenuAction } from "../../components/TaskActionMenu";
import { CommentableFileViewer } from "../../components/CommentableFileViewer";
import { TaskCommentMentionsTextarea } from "../../components/TaskCommentMentionsTextarea";
import { TaskCommentMessage } from "../../components/TaskCommentMessage";
import { TaskEditorForm } from "./TaskEditorForm";

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "file_reference" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

type TaskDetailTab =
  | "runtime"
  | "hierarchy"
  | "dependencies"
  | "repo-files"
  | "attachments"
  | "comments"
  | "timeline"
  | "history";

interface TaskDetailPageProps {
  task: TaskDetail;
  draft: TaskUpsertInput;
  commentDraft: TaskCommentInput;
  fileReferenceDraft: TaskFileReferenceInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  taskMessages: MailboxMessage[];
  timelineItems: TaskTimelineItem[];
  dependencyCandidates: Array<{ id: string; number: string; title: string }>;
  selectedBlockerTaskId: string;
  saving: boolean;
  publishing: boolean;
  deleting: boolean;
  loading: boolean;
  sendingMail?: boolean;
  pendingActionId?: string | null;
  onDraftChange: (draft: TaskUpsertInput) => void;
  onCommentDraftChange: (draft: TaskCommentInput) => void;
  onSave: () => void;
  onPublish: () => void;
  onDelete: () => void;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  onDispatch: () => void;
  onRetry: () => void;
  onPauseRuntime: () => void;
  onWhipTask: () => void;
  onResetTask: () => void;
  onComplete: (outcome: "success" | "failure" | "needs_user") => void;
  onApproveCompletion: () => void;
  onSendBackForWork: () => void;
  onAddDependency: () => void;
  onRemoveDependency: (dependencyId: string) => void;
  onSelectBlocker: (taskId: string) => void;
  onAddAttachment: (files: FileList | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onFileReferenceDraftChange: (draft: TaskFileReferenceInput) => void;
  onAddFileReference: () => void;
  onRemoveFileReference: (referenceId: string) => void;
  onSetDefaultFileReference: (referenceId: string) => void;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onUpdateComment: (commentId: string, message: string) => Promise<boolean>;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onSendMail: (body: string, interrupt: boolean) => Promise<void>;
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

function createReplyDraft(author = "User", parentCommentId?: string | null): TaskCommentInput {
  return {
    author,
    message: "",
    interruptAgent: false,
    parentCommentId: parentCommentId ?? null,
  };
}

function groupTaskComments(comments: TaskComment[]) {
  const repliesByParent = new Map<string, TaskComment[]>();
  const topLevelComments: TaskComment[] = [];

  for (const comment of comments) {
    if (!comment.parentCommentId) {
      topLevelComments.push(comment);
      continue;
    }

    const replies = repliesByParent.get(comment.parentCommentId) ?? [];
    replies.push(comment);
    repliesByParent.set(comment.parentCommentId, replies);
  }

  return topLevelComments.map((comment) => ({
    comment,
    replies: repliesByParent.get(comment.id) ?? [],
  }));
}

function formatCommentAnchorLabel(comment: TaskComment) {
  if (!comment.relativePath || !comment.lineStart) {
    return null;
  }

  const lineLabel = comment.lineStart === comment.lineEnd || !comment.lineEnd
    ? `line ${comment.lineStart}`
    : `lines ${comment.lineStart}-${comment.lineEnd}`;

  return `${comment.relativePath} · ${lineLabel}`;
}

function isAnchoredToReference(comment: TaskComment, reference: TaskFileReference | null) {
  if (!reference) {
    return false;
  }
  return comment.repositoryId === reference.repositoryId && comment.relativePath === reference.relativePath;
}

const TAB_OPTIONS: Array<{ id: TaskDetailTab; label: string }> = [
  { id: "repo-files", label: "Repo files" },
  { id: "comments", label: "Comments" },
  { id: "attachments", label: "Attachments" },
  { id: "hierarchy", label: "Hierarchy" },
  { id: "dependencies", label: "Dependencies" },
  { id: "timeline", label: "Timeline" },
  { id: "history", label: "Lane history" },
  { id: "runtime", label: "Runtime" },
];

const DELETE_HOLD_MS = 2000;

export function TaskDetailPage({
  task,
  draft,
  commentDraft,
  fileReferenceDraft,
  workflows,
  agents,
  roles,
  repositories,
  taskMessages,
  timelineItems,
  dependencyCandidates,
  selectedBlockerTaskId,
  saving,
  publishing,
  deleting,
  loading,
  sendingMail = false,
  pendingActionId = null,
  onDraftChange,
  onCommentDraftChange,
  onSave,
  onPublish,
  onDelete,
  onBack,
  onOpenTask,
  onDispatch,
  onRetry,
  onPauseRuntime,
  onWhipTask,
  onResetTask,
  onComplete,
  onApproveCompletion,
  onSendBackForWork,
  onAddDependency,
  onRemoveDependency,
  onSelectBlocker,
  onAddAttachment,
  onRemoveAttachment,
  onFileReferenceDraftChange,
  onAddFileReference,
  onRemoveFileReference,
  onSetDefaultFileReference,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onSendMail,
}: TaskDetailPageProps) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("repo-files");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteHolding, setDeleteHolding] = useState(false);
  const [replyTargetCommentId, setReplyTargetCommentId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<TaskCommentInput>(() => createReplyDraft(commentDraft.author));
  const [mailDraft, setMailDraft] = useState("");
  const [mailInterrupt, setMailInterrupt] = useState(false);
  const [selectedFileReference, setSelectedFileReference] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [defaultFileContent, setDefaultFileContent] = useState<string | null>(null);
  const [loadingDefaultFileContent, setLoadingDefaultFileContent] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [historyLimit, setHistoryLimit] = useState<number>(() => {
    if (typeof window === "undefined") {
      return 5;
    }
    const stored = Number(window.localStorage.getItem("orchestra.taskDetail.historyLimit") ?? "5");
    return [5, 10, 25].includes(stored) ? stored : 5;
  });
  const deleteHoldTimerRef = useRef<number | null>(null);

  const canPublish = task.status === "draft" && Boolean(draft.workflowId && draft.title.trim()) && !publishing && !saving && !loading;
  const commentThreads = groupTaskComments(task.comments);
  const defaultFile = task.fileReferences.find((reference) => reference.isDefault) ?? task.fileReferences[0] ?? null;
  const recentHistory = timelineItems.slice(0, historyLimit);
  const summaryComments = commentThreads.slice(-4).reverse();

  useEffect(() => {
    return () => {
      if (deleteHoldTimerRef.current !== null) {
        window.clearTimeout(deleteHoldTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
    setMailDraft("");
    setMailInterrupt(false);
  }, [task.id]);

  useEffect(() => {
    if (!replyTargetCommentId) {
      setReplyDraft((current) => ({ ...current, author: commentDraft.author }));
    }
  }, [commentDraft.author, replyTargetCommentId]);

  useEffect(() => {
    if (activeTab === "repo-files" && task.fileReferences.length > 0) {
      const selectedReference = task.fileReferences.find((reference) => reference.id === selectedFileReference) ?? null;
      const fileToSelect = selectedReference ?? defaultFile ?? task.fileReferences[0];
      if (!fileToSelect) {
        return;
      }
      if (fileToSelect.id !== selectedFileReference) {
        setSelectedFileReference(fileToSelect.id);
      }
      loadFileContent(fileToSelect);
    }
  }, [activeTab, defaultFile, task.fileReferences, selectedFileReference]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("orchestra.taskDetail.historyLimit", String(historyLimit));
    }
  }, [historyLimit]);

  useEffect(() => {
    if (!defaultFile?.exists || !defaultFile.absolutePath) {
      setDefaultFileContent(null);
      return;
    }
    let canceled = false;
    setLoadingDefaultFileContent(true);
    getTaskFileContent(defaultFile.absolutePath)
      .then((content) => {
        if (!canceled) {
          setDefaultFileContent(content);
        }
      })
      .catch(() => {
        if (!canceled) {
          setDefaultFileContent(null);
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoadingDefaultFileContent(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [defaultFile]);

  async function loadFileContent(reference: TaskFileReference) {
    if (!reference.exists) {
      setFileContent(null);
      return;
    }
    setLoadingFileContent(true);
    try {
      const content = await getTaskFileContent(reference.absolutePath || "");
      setFileContent(content);
    } catch (error) {
      console.error("Failed to load file content:", error);
      setFileContent(null);
    } finally {
      setLoadingFileContent(false);
    }
  }

  async function handleSetDefault(referenceId: string) {
    try {
      await onSetDefaultFileReference(referenceId);
    } catch (error) {
      console.error("Failed to set default file reference:", error);
    }
  }

  function detectLanguage(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const languageMap: Record<string, string> = {
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      ps1: "powershell",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      xml: "xml",
      html: "html",
      css: "css",
      scss: "scss",
      less: "less",
      md: "markdown",
      markdown: "markdown",
      sql: "sql",
      graphql: "graphql",
      dockerfile: "dockerfile",
      makefile: "makefile",
      toml: "toml",
      ini: "ini",
      conf: "ini",
      gitignore: "gitignore",
      env: "bash",
    };
    return languageMap[ext] || "plaintext";
  }

  function highlightCode(code: string, language: string) {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      }
      const result = hljs.highlightAuto(code);
      return result.value;
    } catch {
      return code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
  }

  function buildHeaderActions(): TaskActionMenuAction[] {
    const actions: TaskActionMenuAction[] = [];

    if (task.status === "draft") {
      actions.push({
        id: "publish",
        label: "Dispatch",
        onClick: onPublish,
        disabled: !canPublish,
        variant: "primary",
        dataRole: "publish-task",
      });
    } else if (task.status === "ready") {
      actions.push({
        id: "dispatch-ready",
        label: "Dispatch",
        onClick: onDispatch,
        variant: "primary",
        dataRole: "dispatch-task-lane",
      });
    }

    if (task.activeLaneAssignment?.status === "awaiting_user_approval") {
      actions.push({
        id: "approve-pending",
        label: "Approve",
        onClick: onApproveCompletion,
        variant: "primary",
        dataRole: "approve-task-lane",
      });
      actions.push({
        id: "needs-work-pending",
        label: "Needs work",
        onClick: onSendBackForWork,
        variant: "secondary",
        dataRole: "send-task-back-for-work",
      });
    } else if (task.status === "in_review" && !task.activeLaneAssignment && task.assigneeType === "user" && task.currentLaneId) {
      actions.push({
        id: "approve-user",
        label: "Approve",
        onClick: () => onComplete("success"),
        variant: "primary",
        dataRole: "complete-task-success",
      });
      actions.push({
        id: "needs-work-user",
        label: "Needs work",
        onClick: () => onComplete("failure"),
        variant: "secondary",
        dataRole: "complete-task-failure",
      });
    }

    if (task.activeLaneAssignment?.status === "active" && task.activeLaneAssignment.sessionId) {
      actions.push({
        id: "pause",
        label: "Pause",
        onClick: onPauseRuntime,
        variant: "secondary",
        dataRole: "pause-task-runtime",
      });
    }

    if (task.status !== "draft" && task.status !== "ready" && task.activeLaneAssignment) {
      actions.push({
        id: "whip",
        label: "Whip",
        onClick: onWhipTask,
        variant: "secondary",
        dataRole: "whip-task-runtime",
      });
    }

    return actions;
  }

  function clearDeleteHold() {
    if (deleteHoldTimerRef.current !== null) {
      window.clearTimeout(deleteHoldTimerRef.current);
      deleteHoldTimerRef.current = null;
    }
    setDeleteHolding(false);
  }

  function handleDeletePointerDown() {
    if (deleting) {
      return;
    }
    clearDeleteHold();
    setDeleteHolding(true);
    deleteHoldTimerRef.current = window.setTimeout(() => {
      deleteHoldTimerRef.current = null;
      setDeleteHolding(false);
      setShowDeleteConfirm(true);
    }, DELETE_HOLD_MS);
  }

  function handleDeletePointerEnd(_event?: ReactPointerEvent<HTMLButtonElement>) {
    clearDeleteHold();
  }

  function openReplyComposer(comment: TaskComment) {
    setReplyTargetCommentId(comment.id);
    setReplyDraft(createReplyDraft(commentDraft.author, comment.id));
  }

  async function handleAddTopLevelComment() {
    await onAddComment({ ...commentDraft, parentCommentId: null });
  }

  async function handleAddReply() {
    if (!replyTargetCommentId) {
      return;
    }
    const added = await onAddComment({ ...replyDraft, parentCommentId: replyTargetCommentId });
    if (!added) {
      return;
    }
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
  }

  async function handleSendRuntimeMail() {
    if (!mailDraft.trim()) {
      return;
    }
    await onSendMail(mailDraft, mailInterrupt);
    setMailDraft("");
    setMailInterrupt(false);
  }

  function handleOpenCommentFileReference(reference: TaskFileReference) {
    setActiveTab("repo-files");
    setSelectedFileReference(reference.id);
    loadFileContent(reference);
  }

  function renderTabPanel() {
    switch (activeTab) {
      case "runtime":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-runtime">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Runtime</p>
                <h4>Lane execution</h4>
              </div>
              <TaskActionMenu actions={buildHeaderActions()} menuLabel="Lane actions" pendingActionId={pendingActionId} />
            </div>
            {task.activeLaneAssignment ? (
              <div className="task-runtime-card" data-role="task-runtime-assignment">
                <div className="workflow-section__header">
                  <strong>{task.activeLaneAssignment.workerType} · {task.activeLaneAssignment.workerId ?? "unassigned"}</strong>
                  <span className={`status-badge status-badge--${task.activeLaneAssignment.status === "active" ? "success" : task.activeLaneAssignment.status === "queued" ? "warning" : "neutral"}`}>
                    {task.activeLaneAssignment.status}
                  </span>
                </div>
                <div className="workforce-meta-grid muted-copy">
                  <span>Lane: {task.activeLaneAssignment.laneId}</span>
                  <span>Session: {task.activeLaneAssignment.sessionId ?? "—"}</span>
                  <span>Runtime cwd: {task.activeLaneAssignment.runtimeCwd ?? "—"}</span>
                  <span>Whips: {task.activeLaneAssignment.whipCount ?? 0} / {task.whipMaxAttempts ?? 10}</span>
                  <span>Last whip: {task.activeLaneAssignment.lastWhipAt ?? "—"}</span>
                </div>
                {task.activeLaneAssignment.status === "awaiting_user_approval" ? (
                  <p className="muted-copy" data-role="task-awaiting-approval-note">
                    This lane reported success and is paused for user approval before the workflow continues.
                    {task.activeLaneAssignment.completionNotes ? ` Worker notes: ${task.activeLaneAssignment.completionNotes}` : ""}
                  </p>
                ) : null}
                <div className="action-cluster">
                  <button className="secondary-button secondary-button--danger" data-role="reset-task-runtime" type="button" disabled={Boolean(pendingActionId)} onClick={onResetTask}>
                    Reset task runtime
                  </button>
                </div>

                <div className="task-section-list">
                  <article className="task-history-card">
                    <div className="workflow-section__header">
                      <strong>Send mail to active worker</strong>
                      <span className="status-badge status-badge--neutral">Mailbox</span>
                    </div>
                    <p className="muted-copy">This sends a mailbox message to the currently active assignment session and shows up in the worker's unread mail checks.</p>
                    <label className="field-group">
                      <span className="field-group__label">Message</span>
                      <textarea className="text-area" data-role="task-runtime-mail-body" rows={4} value={mailDraft} onChange={(event) => setMailDraft(event.target.value)} />
                    </label>
                    <label className="checkbox-field">
                      <input data-role="task-runtime-mail-interrupt" type="checkbox" checked={mailInterrupt} onChange={(event) => setMailInterrupt(event.target.checked)} />
                      <span>Interrupt worker immediately</span>
                    </label>
                    <div className="action-cluster">
                      <button className="primary-button" data-role="task-runtime-send-mail" type="button" disabled={sendingMail || !mailDraft.trim()} onClick={() => void handleSendRuntimeMail()}>
                        {sendingMail ? "Sending…" : "Send mail"}
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            ) : (
              <p className="muted-copy">No active runtime assignment for this task.</p>
            )}

            <div className="task-section-list" data-role="task-mail-history">
              {taskMessages.length ? taskMessages.map((message) => (
                <article className="task-history-card" key={message.deliveryId}>
                  <div className="workflow-section__header">
                    <strong>{message.senderLabel} → {message.recipientLabel}</strong>
                    <span className={`status-badge status-badge--${message.readAt ? "neutral" : "warning"}`}>{message.readAt ? "Read" : "Unread"}</span>
                  </div>
                  <p className="muted-copy">{message.priority === "interrupt" ? "Interrupt priority" : "Normal priority"}</p>
                  <p className="pre-wrap">{message.body}</p>
                </article>
              )) : <p className="muted-copy">No task mail yet.</p>}
            </div>
          </section>
        );
      case "hierarchy":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-hierarchy">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Hierarchy</p>
                <h4>Lineage and rollups</h4>
              </div>
            </div>

            {task.lineage.length ? (
              <div className="task-lineage" data-role="task-lineage">
                {task.lineage.map((ancestor) => (
                  <button className="task-lineage__crumb" key={ancestor.id} type="button" onClick={() => onOpenTask(ancestor.id)}>
                    {ancestor.number} · {ancestor.title}
                  </button>
                ))}
                {task.parent ? <span className="task-lineage__current">Parent: {task.parent.number}</span> : null}
              </div>
            ) : (
              <p className="muted-copy">No parent task. This task is currently a top-level item.</p>
            )}

            {task.childCount ? (
              <div className="task-rollup-grid">
                <article className="status-card"><span className="status-card__label">Children</span><strong>{task.childCount}</strong></article>
                <article className="status-card"><span className="status-card__label">In progress</span><strong>{task.inProgressChildCount}</strong></article>
                <article className="status-card"><span className="status-card__label">Blocked</span><strong>{task.blockedChildCount}</strong></article>
                <article className="status-card"><span className="status-card__label">Completed</span><strong>{task.completedChildCount}</strong></article>
              </div>
            ) : null}

            {task.children.length ? (
              <div className="task-section-list" data-role="task-children">
                {task.children.map((child) => (
                  <button className="task-child-card" key={child.id} type="button" onClick={() => onOpenTask(child.id)}>
                    <div className="workflow-section__header">
                      <strong>{child.number} · {child.title}</strong>
                      <span className={`status-badge status-badge--${getStatusTone(child.status)}`}>{formatStatusLabel(child.status)}</span>
                    </div>
                    <p className="muted-copy">{child.type} · {child.priority}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No child tasks yet.</p>
            )}
          </section>
        );
      case "dependencies":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-dependencies">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Dependencies</p>
                <h4>Blocked by and blocking</h4>
              </div>
              <div className="task-dependency-actions">
                <select className="select-input" data-role="dependency-blocker-select" value={selectedBlockerTaskId} onChange={(event) => onSelectBlocker(event.target.value)}>
                  <option value="">Select blocker task…</option>
                  {dependencyCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.number} · {candidate.title}</option>
                  ))}
                </select>
                <button className="secondary-button" data-role="add-dependency" type="button" disabled={!selectedBlockerTaskId} onClick={onAddDependency}>Add dependency</button>
              </div>
            </div>

            {task.dependencyBlocked ? <p className="error-copy">This task is currently blocked by unresolved dependencies and is not dispatchable.</p> : null}
            <div className="task-dependency-grid">
              <div className="task-dependency-column">
                <p className="eyebrow">Blocked by</p>
                {task.blockedBy.length ? (
                  <div className="task-section-list" data-role="task-blocked-by">
                    {task.blockedBy.map((dependency) => (
                      <article className="task-history-card" key={dependency.id}>
                        <div className="workflow-section__header">
                          <strong>{dependency.blocker.number} · {dependency.blocker.title}</strong>
                          <span className={`status-badge status-badge--${getStatusTone(dependency.blocker.status)}`}>{formatStatusLabel(dependency.blocker.status)}</span>
                        </div>
                        <p className="muted-copy">{dependency.blocker.priority} · {dependency.blocker.type}</p>
                        <button className="secondary-button secondary-button--danger" type="button" onClick={() => onRemoveDependency(dependency.id)}>Remove dependency</button>
                      </article>
                    ))}
                  </div>
                ) : <p className="muted-copy">No blockers. This task can proceed unless workflow state says otherwise.</p>}
              </div>
              <div className="task-dependency-column">
                <p className="eyebrow">Blocking</p>
                {task.blocking.length ? (
                  <div className="task-section-list" data-role="task-blocking">
                    {task.blocking.map((dependency) => (
                      <article className="task-history-card" key={dependency.id}>
                        <div className="workflow-section__header">
                          <strong>{dependency.blocked.number} · {dependency.blocked.title}</strong>
                          <span className={`status-badge status-badge--${getStatusTone(dependency.blocked.status)}`}>{formatStatusLabel(dependency.blocked.status)}</span>
                        </div>
                        <p className="muted-copy">This task will stay blocked until the current task is resolved.</p>
                      </article>
                    ))}
                  </div>
                ) : <p className="muted-copy">No downstream blocked tasks yet.</p>}
              </div>
            </div>
          </section>
        );
      case "repo-files":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-repo-files">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Repo files</p>
                <h4>Tracked repository file changes and references</h4>
                <p className="muted-copy">Use this panel for important repository artifacts that should stay visible on the task, such as design docs, diagrams, plans, ADRs, and other central non-source files.</p>
              </div>
            </div>

            {task.taskRepositories.length ? (
              <div className="task-section-list" data-role="task-repositories-info">
                {task.taskRepositories.map((repository) => (
                  <article className="task-history-card" key={repository.repositoryId}>
                    <div className="workflow-section__header">
                      <strong>{repository.repositoryName}</strong>
                      <span className="status-badge status-badge--neutral">{repository.sourceKind ?? "managed"}</span>
                    </div>
                    <div className="workforce-meta-grid muted-copy">
                      <span>Repository slug: {repository.repositorySlug}</span>
                      <span>Managed path: {repository.managedRepositoryPath ?? "Unavailable"}</span>
                      <span>Source path: {repository.sourcePath ?? "Unavailable"}</span>
                      <span>Task worktree: {repository.taskWorktreePath ?? "Not materialized yet"}</span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No repositories are currently associated with this task.</p>
            )}

            <div className="task-editor-grid">
              <label className="field-group">
                <span className="field-group__label">Repository</span>
                <select className="select-input" data-role="task-file-reference-repository" value={fileReferenceDraft.repositoryId} onChange={(event) => onFileReferenceDraftChange({ ...fileReferenceDraft, repositoryId: event.target.value })}>
                  <option value="">Select repository…</option>
                  {repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>{repository.name}</option>
                  ))}
                </select>
              </label>
              <label className="field-group">
                <span className="field-group__label">Relative path</span>
                <input className="text-input" data-role="task-file-reference-path" value={fileReferenceDraft.relativePath} onChange={(event) => onFileReferenceDraftChange({ ...fileReferenceDraft, relativePath: event.target.value })} placeholder="docs/design.md" />
              </label>
              <div className="task-editor-grid__full">
                <button className="secondary-button" data-role="add-task-file-reference" type="button" disabled={!fileReferenceDraft.repositoryId || !fileReferenceDraft.relativePath.trim()} onClick={onAddFileReference}>Add file reference</button>
              </div>
            </div>

            {task.fileReferences.length ? (
              <div className="task-section-list" data-role="task-file-references">
                <div className="field-group">
                  <span className="field-group__label">View file</span>
                  <select
                    className="select-input"
                    value={selectedFileReference ?? ""}
                    onChange={(event) => {
                      const selectedId = event.target.value;
                      setSelectedFileReference(selectedId);
                      const reference = task.fileReferences.find((ref) => ref.id === selectedId);
                      if (reference) {
                        loadFileContent(reference);
                      }
                    }}
                  >
                    {task.fileReferences.map((reference) => (
                      <option key={reference.id} value={reference.id}>
                        {reference.repositoryName} · {reference.relativePath}
                        {reference.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedFileReference && task.fileReferences.find((ref) => ref.id === selectedFileReference) && (() => {
                  const reference = task.fileReferences.find((ref) => ref.id === selectedFileReference);
                  if (!reference) return null;

                  const language = detectLanguage(reference.relativePath);

                  return (
                    <article className="task-history-card task-history-card--file-reference" key={reference.id}>
                      <div className="workflow-section__header">
                        <strong>
                          {reference.repositoryName} · {reference.relativePath}
                          {reference.isDefault ? <span className="status-badge status-badge--neutral ml-2">Default</span> : null}
                        </strong>
                        <div className="action-cluster">
                          <span className={`status-badge status-badge--${reference.exists ? "success" : "warning"}`}>
                            {reference.exists ? "Available" : "Missing"}
                          </span>
                          {!reference.isDefault && (
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => handleSetDefault(reference.id)}
                            >
                              Set as default
                            </button>
                          )}
                          <button
                            className="secondary-button secondary-button--danger"
                            type="button"
                            onClick={() => onRemoveFileReference(reference.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <p className="muted-copy">Repository slug: {reference.repositorySlug}</p>
                      <p className="muted-copy">Resolved path: {reference.relativePath}</p>
                    </article>
                  );
                })()}

                {selectedFileReference && fileContent !== null && (() => {
                  const reference = task.fileReferences.find((ref) => ref.id === selectedFileReference);
                  if (!reference) return null;

                  const language = detectLanguage(reference.relativePath);

                  return (
                    <div className="file-content-viewer">
                      <div className="file-content-viewer__header">
                        <span className="field-group__label">File content</span>
                        <span className="muted-copy">{reference.relativePath}</span>
                      </div>
                      {loadingFileContent ? (
                        <p className="muted-copy">Loading file content…</p>
                      ) : (
                        <pre
                          className="file-content-viewer__code"
                          dangerouslySetInnerHTML={{
                            __html: highlightCode(fileContent, language),
                          }}
                        />
                      )}
                    </div>
                  );
                })()}

                {selectedFileReference && fileContent === null && !loadingFileContent && (() => {
                  const reference = task.fileReferences.find((ref) => ref.id === selectedFileReference);
                  if (!reference || reference.exists) return null;

                  return (
                    <div className="file-content-viewer">
                      <div className="file-content-viewer__header">
                        <span className="field-group__label">File not available</span>
                        <span className="muted-copy">{reference.relativePath}</span>
                      </div>
                      <p className="muted-copy">
                        This file cannot be found at {reference.relativePath} in the resolved worktree or repository.
                        It may have been moved, deleted, or the task worktree has not been materialized yet.
                      </p>
                    </div>
                  );
                })()}
              </div>
            ) : <p className="muted-copy">No repo files tracked yet. Add an important repository file here to keep it visible on the task for workers and reviewers.</p>}
          </section>
        );
      case "attachments":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-attachments">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Attachments</p>
                <h4>Task materials</h4>
              </div>
              <label className="secondary-button task-attachment-upload">
                <input data-role="task-attachment-input" type="file" multiple onChange={(event) => onAddAttachment(event.target.files)} />
                Add attachment
              </label>
            </div>

            {task.attachments.length ? (
              <div className="task-attachment-grid" data-role="task-attachments">
                {task.attachments.map((attachment) => (
                  <article className="task-attachment-card" key={attachment.id}>
                    <div className="workflow-section__header">
                      <strong>{attachment.fileName}</strong>
                      <button className="secondary-button secondary-button--danger" type="button" onClick={() => onRemoveAttachment(attachment.id)}>Remove</button>
                    </div>
                    <p className="muted-copy">{attachment.mediaType} · {Math.max(1, Math.round(attachment.byteSize / 1024))} KB</p>
                    {attachment.imageDataUrl ? <img alt={attachment.fileName} className="task-attachment-card__image" src={attachment.imageDataUrl} /> : null}
                    {attachment.previewText ? <pre className="task-attachment-card__text">{attachment.previewText}</pre> : null}
                  </article>
                ))}
              </div>
            ) : <p className="muted-copy">No attachments yet. Upload text or image files to give agents richer task context.</p>}
          </section>
        );
      case "comments":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-comments">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Comments</p>
                <h4>Task conversation</h4>
              </div>
            </div>

            <div className="task-comment-composer">
              <div className="task-comment-composer__grid">
                <label className="field-group">
                  <span className="field-group__label">Author</span>
                  <input className="text-input" data-role="task-comment-author" value={commentDraft.author} onChange={(event) => onCommentDraftChange({ ...commentDraft, author: event.target.value })} />
                </label>
                <label className="checkbox-row task-comment-composer__interrupt">
                  <input data-role="task-comment-interrupt" type="checkbox" checked={commentDraft.interruptAgent} onChange={(event) => onCommentDraftChange({ ...commentDraft, interruptAgent: event.target.checked })} />
                  Interrupt current worker now
                </label>
              </div>
              <label className="field-group">
                <span className="field-group__label">Add comment</span>
                <TaskCommentMentionsTextarea
                  taskId={task.id}
                  value={commentDraft.message}
                  rows={4}
                  dataRole="task-comment-message"
                  listDataRole="task-comment-mention-list"
                  optionDataRole="task-comment-mention-option"
                  onChange={(message) => onCommentDraftChange({ ...commentDraft, message })}
                />
              </label>
              <div className="task-comment-composer__actions">
                <button className="primary-button" data-role="add-task-comment" type="button" onClick={() => void handleAddTopLevelComment()}>Add comment</button>
              </div>
            </div>

            {commentThreads.length ? (
              <div className="task-section-list" data-role="task-comments">
                {commentThreads.map(({ comment, replies }) => (
                  <article className="task-comment-thread" data-role="task-comment-thread" key={comment.id}>
                    <article className="transcript-event transcript-event--system task-comment-thread__parent" data-role="task-comment-item">
                      <div className="transcript-event__meta">
                        <span>{comment.author}</span>
                        <div className="transcript-event__meta-group">
                          {comment.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
                          {formatCommentAnchorLabel(comment) ? <span className="status-badge status-badge--accent">{formatCommentAnchorLabel(comment)}</span> : null}
                          {isAnchoredToReference(comment, defaultFile) ? <span className="status-badge status-badge--neutral">Default file</span> : null}
                          <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
                        </div>
                      </div>
                      <TaskCommentMessage
                        dataRole="task-comment-file-mention-link"
                        fileReferences={task.fileReferences}
                        message={comment.message}
                        onOpenFileReference={handleOpenCommentFileReference}
                      />
                      {comment.selectedText ? <pre className="task-comment-thread__quote">{comment.selectedText}</pre> : null}
                      <div className="task-comment-thread__actions">
                        <button className="secondary-button" data-role="reply-task-comment" data-comment-id={comment.id} type="button" onClick={() => openReplyComposer(comment)}>
                          Reply
                        </button>
                      </div>
                    </article>

                    {replies.length ? (
                      <div className="task-comment-thread__replies" data-role="task-comment-replies">
                        {replies.map((reply) => (
                          <article className="transcript-event transcript-event--system task-comment-thread__reply" data-role="task-comment-reply" key={reply.id}>
                            <div className="transcript-event__meta">
                              <span>{reply.author}</span>
                              <div className="transcript-event__meta-group">
                                {reply.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
                                {formatCommentAnchorLabel(reply) ? <span className="status-badge status-badge--accent">{formatCommentAnchorLabel(reply)}</span> : null}
                                {isAnchoredToReference(reply, defaultFile) ? <span className="status-badge status-badge--neutral">Default file</span> : null}
                                <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                              </div>
                            </div>
                            <TaskCommentMessage
                              dataRole="task-comment-file-mention-link"
                              fileReferences={task.fileReferences}
                              message={reply.message}
                              onOpenFileReference={handleOpenCommentFileReference}
                            />
                            {reply.selectedText ? <pre className="task-comment-thread__quote">{reply.selectedText}</pre> : null}
                          </article>
                        ))}
                      </div>
                    ) : null}

                    {replyTargetCommentId === comment.id ? (
                      <div className="task-comment-reply-composer" data-role="task-comment-reply-composer">
                        <div className="task-comment-composer__grid">
                          <label className="field-group">
                            <span className="field-group__label">Reply author</span>
                            <input className="text-input" data-role="task-reply-author" value={replyDraft.author} onChange={(event) => setReplyDraft({ ...replyDraft, author: event.target.value })} />
                          </label>
                          <label className="checkbox-row task-comment-composer__interrupt">
                            <input data-role="task-reply-interrupt" type="checkbox" checked={replyDraft.interruptAgent} onChange={(event) => setReplyDraft({ ...replyDraft, interruptAgent: event.target.checked })} />
                            Interrupt current worker now
                          </label>
                        </div>
                        <label className="field-group">
                          <span className="field-group__label">Reply to {comment.author}</span>
                          <TaskCommentMentionsTextarea
                            taskId={task.id}
                            value={replyDraft.message}
                            rows={3}
                            dataRole="task-reply-message"
                            listDataRole="task-reply-mention-list"
                            optionDataRole="task-reply-mention-option"
                            onChange={(message) => setReplyDraft({ ...replyDraft, message })}
                          />
                        </label>
                        <div className="task-comment-composer__actions">
                          <button className="primary-button" data-role="add-task-reply" type="button" onClick={() => void handleAddReply()}>
                            Add reply
                          </button>
                          <button className="secondary-button" data-role="cancel-task-reply" type="button" onClick={() => {
                            setReplyTargetCommentId(null);
                            setReplyDraft(createReplyDraft(commentDraft.author));
                          }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : <p className="muted-copy">No comments yet. Add one to capture guidance, review notes, or an interrupt request.</p>}
          </section>
        );
      case "timeline":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-timeline">
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
            ) : <p className="muted-copy">No activity recorded yet.</p>}
          </section>
        );
      case "history":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-history">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Lane history</p>
                <h4>Execution continuity</h4>
              </div>
            </div>

            {task.laneRuns.length ? (
              <div className="task-section-list" data-role="task-lane-history">
                {task.laneRuns.map((laneRun) => (
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
            ) : <p className="muted-copy">No lane runs recorded yet.</p>}
          </section>
        );
    }
  }

  return (
    <>
      <section className="task-page task-detail-page panel">
        <div className="panel__header panel__header--session-detail">
          <div>
            <p className="eyebrow">Task detail</p>
            <h2 data-role="task-title-heading">{draft.title.trim() || task.title}</h2>
            <div className="session-detail__meta">
              <span>{task.number}</span>
              <span>{task.commentCount} comments</span>
              <span>{task.laneRunCount} lane runs</span>
              {task.childCount ? <span>{task.childCount} children</span> : null}
              {task.attachmentCount ? <span>{task.attachmentCount} attachments</span> : null}
              {task.blockedByCount ? <span>{task.blockedByCount} blockers</span> : null}
              <span>{task.readyForDispatch ? "Dispatchable" : "Not dispatchable"}</span>
            </div>
          </div>

          <div className="action-cluster action-cluster--wrap">
            <button className="secondary-button" type="button" onClick={onBack}>
              Back to tasks
            </button>
            <TaskActionMenu actions={buildHeaderActions()} pendingActionId={pendingActionId} />
          </div>
        </div>

        {isEditing ? (
          <div className="task-detail-edit-shell">
            <div className="task-detail-edit-shell__header">
              <div>
                <p className="eyebrow">Edit task</p>
                <h3>Edit details</h3>
              </div>
              <TaskActionMenu
                menuLabel="Edit actions"
                actions={[
                  {
                    id: "done-editing",
                    label: "Done editing",
                    onClick: () => setIsEditing(false),
                    variant: "secondary",
                    dataRole: "close-edit-task",
                  },
                  ...(task.status === "draft"
                    ? [{
                        id: "publish",
                        label: publishing ? "Dispatching…" : "Dispatch",
                        onClick: onPublish,
                        disabled: !canPublish,
                        variant: "secondary" as const,
                        dataRole: "publish-task",
                      }]
                    : []),
                  {
                    id: "save",
                    label: saving ? "Saving…" : "Save changes",
                    onClick: onSave,
                    disabled: saving || loading || !draft.title.trim(),
                    variant: "primary",
                    dataRole: "save-task",
                  },
                  {
                    id: "delete",
                    label: deleting ? "Deleting…" : "Delete",
                    onClick: () => setShowDeleteConfirm(true),
                    disabled: deleting,
                    variant: "danger",
                    dataRole: "delete-task",
                  },
                ]}
                pendingActionId={pendingActionId}
              />
            </div>
            <TaskEditorForm agents={agents} draft={draft} onChange={onDraftChange} repositories={repositories} roles={roles} workflows={workflows} detailLayout showAssigneeFields={false} />
          </div>
        ) : (
          <div className="task-detail-summary">
            <div className="task-detail-summary__header">
              <div>
                <p className="eyebrow">Overview</p>
                <h3>Current context</h3>
              </div>
              <TaskActionMenu
                menuLabel="Overview actions"
                actions={[
                  {
                    id: "edit",
                    label: "Edit Task",
                    onClick: () => setIsEditing(true),
                    variant: "secondary",
                    dataRole: "edit-task",
                  },
                  {
                    id: "delete",
                    label: deleting ? "Deleting…" : "Delete",
                    onClick: () => setShowDeleteConfirm(true),
                    disabled: deleting,
                    variant: "danger",
                    dataRole: "delete-task",
                  },
                ]}
                pendingActionId={pendingActionId}
              />
            </div>

            <div className="task-detail-summary__file task-history-card">
              <div className="workflow-section__header">
                <div>
                  <p className="eyebrow">Default repo file</p>
                  <h4>{defaultFile ? `${defaultFile.repositoryName} · ${defaultFile.relativePath}` : "No default repo file"}</h4>
                </div>
                {defaultFile?.isDefault ? <span className="status-badge status-badge--neutral">Default</span> : null}
              </div>
              {defaultFile ? (
                <>
                  <p className="muted-copy">{defaultFile.exists ? `Resolved file: ${defaultFile.relativePath}` : `File is currently missing from the resolved workspace path for ${defaultFile.relativePath}.`}</p>
                  {defaultFile.exists ? (
                    loadingDefaultFileContent ? (
                      <p className="muted-copy">Loading file preview…</p>
                    ) : (
                      <CommentableFileViewer
                        taskId={task.id}
                        commentDraft={commentDraft}
                        comments={task.comments}
                        content={defaultFileContent ?? ""}
                        fileReferences={task.fileReferences}
                        language={detectLanguage(defaultFile.relativePath)}
                        onAddComment={onAddComment}
                        onCommentDraftChange={onCommentDraftChange}
                        onDeleteComment={onDeleteComment}
                        onOpenFileReference={handleOpenCommentFileReference}
                        onUpdateComment={onUpdateComment}
                        reference={defaultFile}
                      />
                    )
                  ) : null}
                </>
              ) : (
                <p className="muted-copy">Set a default repo file from the Repo files tab to keep the most important file visible here.</p>
              )}
            </div>

            <section className="task-detail-summary__comments task-history-card" data-role="task-detail-summary-comments">
              <div className="task-detail-summary__history-header">
                <div>
                  <p className="eyebrow">Discussion</p>
                  <h4>Comment on this task</h4>
                </div>
                <span className="status-badge status-badge--neutral">{task.commentCount}</span>
              </div>

              <div className="task-comment-composer task-comment-composer--summary">
                <div className="task-comment-composer__grid task-comment-composer__grid--compact">
                  <label className="checkbox-row task-comment-composer__interrupt">
                    <input data-role="default-file-quick-comment-interrupt" type="checkbox" checked={commentDraft.interruptAgent} onChange={(event) => onCommentDraftChange({ ...commentDraft, interruptAgent: event.target.checked })} />
                    Interrupt current worker now
                  </label>
                </div>
                <label className="field-group">
                  <span className="field-group__label">Quick comment</span>
                  <textarea className="text-area" data-role="default-file-quick-comment-message" rows={3} value={commentDraft.message} onChange={(event) => onCommentDraftChange({ ...commentDraft, message: event.target.value })} />
                </label>
                <div className="task-comment-composer__actions">
                  <button className="primary-button" data-role="add-default-file-quick-comment" type="button" onClick={() => void handleAddTopLevelComment()}>Add comment</button>
                </div>
              </div>

              {summaryComments.length ? (
                <div className="task-section-list" data-role="default-file-comment-summary">
                  {summaryComments.map(({ comment, replies }) => (
                    <article className="task-comment-thread task-comment-thread--summary" key={comment.id}>
                      <article className="transcript-event transcript-event--system task-comment-thread__parent" data-role="task-comment-item">
                        <div className="transcript-event__meta">
                          <span>{comment.author}</span>
                          <div className="transcript-event__meta-group">
                            {comment.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
                            {formatCommentAnchorLabel(comment) ? <span className="status-badge status-badge--accent">{formatCommentAnchorLabel(comment)}</span> : null}
                            <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
                          </div>
                        </div>
                        <TaskCommentMessage
                          dataRole="task-comment-file-mention-link"
                          fileReferences={task.fileReferences}
                          message={comment.message}
                          onOpenFileReference={handleOpenCommentFileReference}
                        />
                        {comment.selectedText ? <pre className="task-comment-thread__quote">{comment.selectedText}</pre> : null}
                      </article>
                      {replies.length ? (
                        <div className="task-comment-thread__replies task-comment-thread__replies--summary">
                          {replies.slice(-2).map((reply) => (
                            <article className="transcript-event transcript-event--system task-comment-thread__reply" key={reply.id}>
                              <div className="transcript-event__meta">
                                <span>{reply.author}</span>
                                <div className="transcript-event__meta-group">
                                  {formatCommentAnchorLabel(reply) ? <span className="status-badge status-badge--accent">{formatCommentAnchorLabel(reply)}</span> : null}
                                  <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                                </div>
                              </div>
                              <TaskCommentMessage
                                dataRole="task-comment-file-mention-link"
                                fileReferences={task.fileReferences}
                                message={reply.message}
                                onOpenFileReference={handleOpenCommentFileReference}
                              />
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">No comments yet. Add one here or anchor a comment directly from the file preview.</p>
              )}
            </section>

            <section className="task-detail-summary__history">
              <div className="task-detail-summary__history-header">
                <div>
                  <p className="eyebrow">Recent history</p>
                  <h4>Latest activity</h4>
                </div>
                <label className="field-group">
                  <span className="field-group__label">Items</span>
                  <select className="select-input" data-role="task-history-limit" value={String(historyLimit)} onChange={(event) => setHistoryLimit(Number(event.target.value))}>
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="25">25</option>
                  </select>
                </label>
              </div>
              {recentHistory.length ? (
                <div className="task-detail-summary__history-list">
                  {recentHistory.map((item) => (
                    <article className="task-detail-summary__history-item" key={item.id}>
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
                <p className="muted-copy">No recent activity yet.</p>
              )}
            </section>
          </div>
        )}
      </section>

      <section className="panel task-detail-tabs-panel">
        <div className="task-detail-tabs" role="tablist" aria-label="Task detail panels">
          {TAB_OPTIONS.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "task-detail-tab task-detail-tab--active" : "task-detail-tab"}
              data-role={`task-detail-tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="task-detail-tabs__body">{renderTabPanel()}</div>
      </section>

      {showDeleteConfirm ? (
        <div className="quick-chat-overlay" data-role="task-delete-confirm-overlay" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <section className="quick-chat-modal panel task-delete-confirm" data-role="task-delete-confirm" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Delete task</p>
                <h3>Delete {task.number}?</h3>
              </div>
            </div>
            <p>This permanently deletes the task, its comments, attachments, dependencies, and lane history.</p>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" disabled={deleting} onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button className="secondary-button secondary-button--danger" data-role="confirm-delete-task" type="button" disabled={deleting} onClick={onDelete}>
                {deleting ? "Deleting…" : "Delete task"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
