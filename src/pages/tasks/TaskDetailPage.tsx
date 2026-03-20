import type { AgentSummary, RoleSummary, TaskCommentInput, TaskDetail, TaskPriority, TaskStatus, TaskType, TaskUpsertInput, WorkflowSummary } from "../../types";
import { TaskEditorForm } from "./TaskEditorForm";

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

interface TaskDetailPageProps {
  task: TaskDetail;
  draft: TaskUpsertInput;
  commentDraft: TaskCommentInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  timelineItems: TaskTimelineItem[];
  dependencyCandidates: Array<{ id: string; number: string; title: string }>;
  selectedBlockerTaskId: string;
  saving: boolean;
  loading: boolean;
  onDraftChange: (draft: TaskUpsertInput) => void;
  onCommentDraftChange: (draft: TaskCommentInput) => void;
  onSave: () => void;
  onBack: () => void;
  onCreateSubtask: () => void;
  onOpenTask: (taskId: string) => void;
  onDispatch: () => void;
  onComplete: (outcome: "success" | "failure" | "needs_user") => void;
  onAddDependency: () => void;
  onRemoveDependency: (dependencyId: string) => void;
  onSelectBlocker: (taskId: string) => void;
  onAddAttachment: (files: FileList | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onAddComment: () => void;
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

export function TaskDetailPage({
  task,
  draft,
  commentDraft,
  workflows,
  agents,
  roles,
  timelineItems,
  dependencyCandidates,
  selectedBlockerTaskId,
  saving,
  loading,
  onDraftChange,
  onCommentDraftChange,
  onSave,
  onBack,
  onCreateSubtask,
  onOpenTask,
  onDispatch,
  onComplete,
  onAddDependency,
  onRemoveDependency,
  onSelectBlocker,
  onAddAttachment,
  onRemoveAttachment,
  onAddComment,
}: TaskDetailPageProps) {
  return (
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

        <div className="action-cluster">
          <button className="secondary-button" type="button" onClick={onBack}>
            Back to tasks
          </button>
          <button className="secondary-button" data-role="new-subtask" type="button" onClick={onCreateSubtask}>
            New subtask
          </button>
          {task.readyForDispatch ? (
            <button className="primary-button" data-role="dispatch-task-lane" type="button" onClick={onDispatch}>
              Dispatch lane
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
          <button className="primary-button" data-role="save-task" type="button" disabled={saving || loading} onClick={onSave}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <TaskEditorForm agents={agents} draft={draft} onChange={onDraftChange} roles={roles} workflows={workflows} />

      <div className="task-detail-sections">
        <section className="task-section">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Runtime</p>
              <h4>Lane execution</h4>
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
              </div>
            </div>
          ) : (
            <p className="muted-copy">No active runtime assignment for this task.</p>
          )}
        </section>

        <section className="task-section">
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
            <p className="muted-copy">No child tasks yet. Use “New subtask” to break work down under this task.</p>
          )}
        </section>

        <section className="task-section">
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

        <section className="task-section">
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

        <section className="task-section">
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
              <button className="primary-button" data-role="add-task-comment" type="button" onClick={onAddComment}>Add comment</button>
            </div>
          </div>

          {task.comments.length ? (
            <div className="task-section-list" data-role="task-comments">
              {task.comments.map((comment) => (
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
          ) : <p className="muted-copy">No comments yet. Add one to capture guidance, review notes, or an interrupt request.</p>}
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
          ) : <p className="muted-copy">No activity recorded yet.</p>}
        </section>

        <section className="task-section">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Lane history</p>
              <h4>Execution continuity</h4>
            </div>
          </div>

          {task.laneRuns.length ? (
            <div className="task-section-list">
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
      </div>
    </section>
  );
}
