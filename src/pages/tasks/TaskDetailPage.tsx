import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { AgentSummary, RepositoryRecord, RoleSummary, TaskComment, TaskCommentInput, TaskDetail, TaskFileReferenceInput, TaskUpsertInput, WorkflowSummary } from "../../types";
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
  timelineItems: TaskTimelineItem[];
  dependencyCandidates: Array<{ id: string; number: string; title: string }>;
  selectedBlockerTaskId: string;
  saving: boolean;
  publishing: boolean;
  deleting: boolean;
  loading: boolean;
  onDraftChange: (draft: TaskUpsertInput) => void;
  onCommentDraftChange: (draft: TaskCommentInput) => void;
  onSave: () => void;
  onPublish: () => void;
  onDelete: () => void;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  onDispatch: () => void;
  onRetry: () => void;
  onComplete: (outcome: "success" | "failure" | "needs_user") => void;
  onAddDependency: () => void;
  onRemoveDependency: (dependencyId: string) => void;
  onSelectBlocker: (taskId: string) => void;
  onAddAttachment: (files: FileList | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onFileReferenceDraftChange: (draft: TaskFileReferenceInput) => void;
  onAddFileReference: () => void;
  onRemoveFileReference: (referenceId: string) => void;
  onAddComment: (draft: TaskCommentInput) => Promise<void>;
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

const TAB_OPTIONS: Array<{ id: TaskDetailTab; label: string }> = [
  { id: "runtime", label: "Runtime" },
  { id: "hierarchy", label: "Hierarchy" },
  { id: "dependencies", label: "Dependencies" },
  { id: "repo-files", label: "Repo files" },
  { id: "attachments", label: "Attachments" },
  { id: "comments", label: "Comments" },
  { id: "timeline", label: "Timeline" },
  { id: "history", label: "Lane history" },
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
  timelineItems,
  dependencyCandidates,
  selectedBlockerTaskId,
  saving,
  publishing,
  deleting,
  loading,
  onDraftChange,
  onCommentDraftChange,
  onSave,
  onPublish,
  onDelete,
  onBack,
  onOpenTask,
  onDispatch,
  onRetry,
  onComplete,
  onAddDependency,
  onRemoveDependency,
  onSelectBlocker,
  onAddAttachment,
  onRemoveAttachment,
  onFileReferenceDraftChange,
  onAddFileReference,
  onRemoveFileReference,
  onAddComment,
}: TaskDetailPageProps) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("runtime");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteHolding, setDeleteHolding] = useState(false);
  const [replyTargetCommentId, setReplyTargetCommentId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<TaskCommentInput>(() => createReplyDraft(commentDraft.author));
  const deleteHoldTimerRef = useRef<number | null>(null);

  const canPublish = task.status === "draft" && Boolean(draft.workflowId && draft.title.trim()) && !publishing && !saving && !loading;
  const commentThreads = groupTaskComments(task.comments);

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
  }, [task.id]);

  useEffect(() => {
    if (!replyTargetCommentId) {
      setReplyDraft((current) => ({ ...current, author: commentDraft.author }));
    }
  }, [commentDraft.author, replyTargetCommentId]);

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
    await onAddComment({ ...replyDraft, parentCommentId: replyTargetCommentId });
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
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
              <div className="action-cluster action-cluster--wrap">
                {task.readyForDispatch ? (
                  <button className="primary-button" data-role="dispatch-task-lane" type="button" onClick={onDispatch}>
                    Dispatch lane
                  </button>
                ) : null}
                {task.workflowId && task.currentLaneId && ["agent", "role"].includes(task.assigneeType) ? (
                  <button className="secondary-button" data-role="retry-task-lane" type="button" onClick={onRetry}>
                    Retry
                  </button>
                ) : null}
                {task.activeLaneAssignment || (task.workflowId && task.currentLaneId && task.assigneeType === "user") ? (
                  <>
                    <button className="secondary-button" data-role="complete-task-success" type="button" onClick={() => onComplete("success")}>
                      Mark success
                    </button>
                    <button className="secondary-button secondary-button--danger" data-role="complete-task-failure" type="button" onClick={() => onComplete("failure")}>
                      Mark failure
                    </button>
                    <button className="secondary-button" data-role="complete-task-needs-user" type="button" onClick={() => onComplete("needs_user")}>
                      Needs user
                    </button>
                  </>
                ) : null}
              </div>
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
              </div>
            ) : (
              <p className="muted-copy">No active runtime assignment for this task.</p>
            )}
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
                {task.fileReferences.map((reference) => (
                  <article className="task-history-card task-history-card--file-reference" key={reference.id}>
                    <div className="workflow-section__header">
                      <strong>{reference.repositoryName} · {reference.relativePath}</strong>
                      <div className="action-cluster">
                        <span className={`status-badge status-badge--${reference.exists ? "success" : "warning"}`}>{reference.exists ? "Available" : "Missing"}</span>
                        <button className="secondary-button secondary-button--danger" type="button" onClick={() => onRemoveFileReference(reference.id)}>Remove</button>
                      </div>
                    </div>
                    <p className="muted-copy">Repository slug: {reference.repositorySlug}</p>
                    <p className="muted-copy">Absolute path: {reference.absolutePath ?? "Unavailable"}</p>
                  </article>
                ))}
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
                <textarea className="text-area" data-role="task-comment-message" rows={4} value={commentDraft.message} onChange={(event) => onCommentDraftChange({ ...commentDraft, message: event.target.value })} />
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
                          <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
                        </div>
                      </div>
                      <p>{comment.message}</p>
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
                                <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                              </div>
                            </div>
                            <p>{reply.message}</p>
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
                          <textarea className="text-area" data-role="task-reply-message" rows={3} value={replyDraft.message} onChange={(event) => setReplyDraft({ ...replyDraft, message: event.target.value })} />
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
            {task.status === "draft" ? (
              <button className="secondary-button" data-role="publish-task" type="button" disabled={!canPublish} onClick={onPublish}>
                {publishing ? "Publishing…" : "Publish"}
              </button>
            ) : null}
            <button className="primary-button" data-role="save-task" type="button" disabled={saving || loading || !draft.title.trim()} onClick={onSave}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              className={deleteHolding ? "secondary-button secondary-button--danger task-delete-button task-delete-button--holding" : "secondary-button secondary-button--danger task-delete-button"}
              data-role="delete-task"
              data-delete-holding={deleteHolding ? "true" : "false"}
              type="button"
              disabled={deleting}
              onPointerDown={handleDeletePointerDown}
              onPointerUp={handleDeletePointerEnd}
              onPointerLeave={handleDeletePointerEnd}
              onPointerCancel={handleDeletePointerEnd}
            >
              <span className="task-delete-button__pulse" aria-hidden="true" />
              <span>{deleting ? "Deleting…" : "Delete"}</span>
            </button>
          </div>
        </div>

        <TaskEditorForm agents={agents} draft={draft} onChange={onDraftChange} repositories={repositories} roles={roles} workflows={workflows} />
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
