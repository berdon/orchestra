import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { TaskCommentComposer } from "../../components/TaskCommentComposer";
import { TaskCommentMessage } from "../../components/TaskCommentMessage";
import { useOrchestraBootstrap } from "../../lib/orchestraClient/provider";
import { buildTaskCommentThreads, sortTaskCommentThreadsByLatestActivityDesc, type TaskCommentThread } from "../../lib/taskCommentThreads";
import { getTaskCommentDeleteActionState, type TaskCommentDeleteActionState } from "../../lib/taskCommentDeleteAction";
import { formatTaskCommentAnchorLabel, isTaskCommentAnchoredToReference } from "../../lib/taskComments";
import { shouldShowUnreadCommentAttention } from "../../lib/taskUnreadCommentVisibility";
import { useExplanatoryTooltipProps } from "../../lib/tooltips";
import type { AgentSummary, RoleSummary, TaskComment, TaskCommentInput, TaskDetail, TaskFileReference, TaskSummary } from "../../types";

interface TaskConversationSectionProps {
  task: TaskDetail;
  defaultFile: TaskFileReference | null;
  commentDraft: TaskCommentInput;
  currentTaskTags: string[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  onCommentDraftChange: Dispatch<SetStateAction<TaskCommentInput>>;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
}

interface ReplyComposerState {
  draft: TaskCommentInput;
  messageRef: MutableRefObject<HTMLTextAreaElement | null>;
  onAuthorChange: (author: string) => void;
  onInterruptChange: (interruptAgent: boolean) => void;
  onMessageChange: (message: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function createReplyDraft(author = "User", parentCommentId?: string | null): TaskCommentInput {
  return {
    author,
    message: "",
    interruptAgent: false,
    parentCommentId: parentCommentId ?? null,
  };
}

const TaskCommentActionMenu = memo(function TaskCommentActionMenu({
  comment,
  deleteAction,
  onDeleteComment,
  onReply,
}: {
  comment: TaskComment;
  deleteAction: TaskCommentDeleteActionState;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onReply: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="task-comment-thread__actions">
      <button className="secondary-button" data-role="reply-task-comment" data-comment-id={comment.id} data-parent-comment-id={comment.parentCommentId ?? undefined} type="button" onClick={onReply}>
        Reply
      </button>
      <div className="task-comment-actions-menu" ref={rootRef}>
        <button
          className="secondary-button task-comment-actions-menu__trigger"
          data-role="task-comment-overflow-trigger"
          data-comment-id={comment.id}
          data-parent-comment-id={comment.parentCommentId ?? undefined}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`More actions for ${comment.author}'s comment`}
          title="More actions"
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {open ? (
          <div className="task-action-menu__dropdown task-comment-actions-menu__dropdown" data-role="task-comment-overflow-menu" data-comment-id={comment.id} role="menu">
            <button
              className="secondary-button secondary-button--danger task-action-menu__dropdown-button"
              data-role="comment-delete"
              data-comment-id={comment.id}
              disabled={!deleteAction.enabled}
              type="button"
              role="menuitem"
              {...getTooltipProps(deleteAction.reason)}
              onClick={() => {
                setOpen(false);
                if (!deleteAction.enabled) {
                  return;
                }
                void onDeleteComment(comment.id);
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

TaskCommentActionMenu.displayName = "TaskCommentActionMenu";

const TaskCommentThreadItem = memo(function TaskCommentThreadItem({
  thread,
  defaultFile,
  taskId,
  currentTaskTags,
  fileReferences,
  tasks,
  agents,
  roles,
  deleteAction,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
  onDeleteComment,
  onReply,
  replyComposer,
}: {
  thread: TaskCommentThread;
  defaultFile: TaskFileReference | null;
  taskId: string;
  currentTaskTags: string[];
  fileReferences: TaskFileReference[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  deleteAction: TaskCommentDeleteActionState;
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onReply: (comment: TaskComment) => void;
  replyComposer: ReplyComposerState | null;
}) {
  const { comment, replies } = thread;

  return (
    <article className="task-comment-thread" data-role="task-comment-thread">
      <article className="transcript-event transcript-event--system task-comment-thread__parent" data-role="task-comment-item" data-comment-id={comment.id}>
        <div className="transcript-event__meta">
          <span>{comment.author}</span>
          <div className="transcript-event__meta-group">
            {comment.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
            {formatTaskCommentAnchorLabel(comment) ? <span className="status-badge status-badge--accent">{formatTaskCommentAnchorLabel(comment)}</span> : null}
            {isTaskCommentAnchoredToReference(comment, defaultFile) ? <span className="status-badge status-badge--neutral">Default file</span> : null}
            <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
          </div>
        </div>
        <TaskCommentMessage
          dataRole="task-comment-mention-link"
          fileReferences={fileReferences}
          tasks={tasks}
          agents={agents}
          roles={roles}
          message={comment.message}
          onOpenFileReference={onOpenFileReference}
          onOpenTask={onOpenTask}
          onOpenAgent={onOpenAgent}
          onOpenRole={onOpenRole}
        />
        {comment.selectedText ? <pre className="task-comment-thread__quote">{comment.selectedText}</pre> : null}
        <TaskCommentActionMenu
          comment={comment}
          deleteAction={deleteAction}
          onDeleteComment={onDeleteComment}
          onReply={() => onReply(comment)}
        />
      </article>

      {replies.length ? (
        <div className="task-comment-thread__replies" data-role="task-comment-replies">
          {replies.map((reply) => (
            <article className="transcript-event transcript-event--system task-comment-thread__reply" data-role="task-comment-reply" data-comment-id={reply.id} data-parent-comment-id={comment.id} key={reply.id}>
              <div className="transcript-event__meta">
                <span>{reply.author}</span>
                <div className="transcript-event__meta-group">
                  {reply.interruptAgent ? <span className="pending-badge">Interrupt requested</span> : null}
                  {formatTaskCommentAnchorLabel(reply) ? <span className="status-badge status-badge--accent">{formatTaskCommentAnchorLabel(reply)}</span> : null}
                  {isTaskCommentAnchoredToReference(reply, defaultFile) ? <span className="status-badge status-badge--neutral">Default file</span> : null}
                  <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                </div>
              </div>
              <TaskCommentMessage
                dataRole="task-comment-mention-link"
                fileReferences={fileReferences}
                tasks={tasks}
                agents={agents}
                roles={roles}
                message={reply.message}
                onOpenFileReference={onOpenFileReference}
                onOpenTask={onOpenTask}
                onOpenAgent={onOpenAgent}
                onOpenRole={onOpenRole}
              />
              {reply.selectedText ? <pre className="task-comment-thread__quote">{reply.selectedText}</pre> : null}
              <TaskCommentActionMenu
                comment={reply}
                deleteAction={deleteAction}
                onDeleteComment={onDeleteComment}
                onReply={() => onReply(comment)}
              />
            </article>
          ))}
        </div>
      ) : null}

      {replyComposer ? (
        <TaskCommentComposer
          author={replyComposer.draft.author}
          authorDataRole="task-reply-author"
          className="task-comment-reply-composer"
          tasks={tasks}
          agents={agents}
          roles={roles}
          currentTaskTags={currentTaskTags}
          interruptChecked={replyComposer.draft.interruptAgent}
          interruptDataRole="task-reply-interrupt"
          message={replyComposer.draft.message}
          messageDataRole="task-reply-message"
          messageRef={replyComposer.messageRef}
          messageLabel={`Reply to ${comment.author}`}
          mentionListDataRole="task-reply-mention-list"
          mentionOptionDataRole="task-reply-mention-option"
          onAuthorChange={replyComposer.onAuthorChange}
          onCancel={replyComposer.onCancel}
          onInterruptChange={replyComposer.onInterruptChange}
          onMessageChange={replyComposer.onMessageChange}
          onSubmit={replyComposer.onSubmit}
          rows={3}
          submitDataRole="add-task-reply"
          submitLabel="Add reply"
          cancelDataRole="cancel-task-reply"
          cancelLabel="Cancel"
          taskId={taskId}
        />
      ) : null}
    </article>
  );
});

TaskCommentThreadItem.displayName = "TaskCommentThreadItem";

export function TaskConversationSection({
  task,
  defaultFile,
  commentDraft,
  currentTaskTags,
  tasks,
  agents,
  roles,
  onCommentDraftChange,
  onAddComment,
  onDeleteComment,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
}: TaskConversationSectionProps) {
  const [commentMessage, setCommentMessage] = useState("");
  const [replyTargetCommentId, setReplyTargetCommentId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<TaskCommentInput>(() => createReplyDraft(commentDraft.author));
  const [pendingReplyFocusTargetId, setPendingReplyFocusTargetId] = useState<string | null>(null);
  const replyMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const bootstrap = useOrchestraBootstrap();

  const commentThreads = useMemo(
    () => sortTaskCommentThreadsByLatestActivityDesc(buildTaskCommentThreads(task.comments)),
    [task.comments],
  );
  const taskCommentDeleteAction = useMemo(() => getTaskCommentDeleteActionState(bootstrap), [bootstrap]);

  useEffect(() => {
    setCommentMessage("");
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
    setPendingReplyFocusTargetId(null);
  }, [task.id]);

  useEffect(() => {
    if (!replyTargetCommentId) {
      setReplyDraft((current) => ({ ...current, author: commentDraft.author }));
    }
  }, [commentDraft.author, replyTargetCommentId]);

  useEffect(() => {
    if (!replyTargetCommentId || task.comments.some((comment) => comment.id === replyTargetCommentId)) {
      return;
    }
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
    setPendingReplyFocusTargetId(null);
  }, [commentDraft.author, replyTargetCommentId, task.comments]);

  useEffect(() => {
    if (!pendingReplyFocusTargetId || pendingReplyFocusTargetId !== replyTargetCommentId) {
      return;
    }

    let timeoutId: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      const replyMessage = replyMessageRef.current;
      if (!replyMessage) {
        return;
      }
      replyMessage.scrollIntoView({ block: "center", behavior: "auto" });
      timeoutId = window.setTimeout(() => {
        replyMessage.focus();
        setPendingReplyFocusTargetId(null);
      }, 50);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [pendingReplyFocusTargetId, replyTargetCommentId]);

  const openReplyComposer = useCallback((threadComment: TaskComment) => {
    setReplyTargetCommentId(threadComment.id);
    setReplyDraft(createReplyDraft(commentDraft.author, threadComment.id));
    setPendingReplyFocusTargetId(threadComment.id);
  }, [commentDraft.author]);

  const handleCancelReply = useCallback(() => {
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
    setPendingReplyFocusTargetId(null);
  }, [commentDraft.author]);

  const handleTopLevelCommentAuthorChange = useCallback((author: string) => {
    onCommentDraftChange((current) => current.author === author ? current : { ...current, author });
  }, [onCommentDraftChange]);

  const handleTopLevelCommentInterruptChange = useCallback((interruptAgent: boolean) => {
    onCommentDraftChange((current) => current.interruptAgent === interruptAgent ? current : { ...current, interruptAgent });
  }, [onCommentDraftChange]);

  const handleAddTopLevelComment = useCallback(async () => {
    const added = await onAddComment({ ...commentDraft, message: commentMessage, parentCommentId: null });
    if (added) {
      setCommentMessage("");
    }
  }, [commentDraft, commentMessage, onAddComment]);

  const handleAddReply = useCallback(async () => {
    if (!replyTargetCommentId) {
      return;
    }
    const added = await onAddComment({ ...replyDraft, parentCommentId: replyTargetCommentId });
    if (!added) {
      return;
    }
    handleCancelReply();
  }, [handleCancelReply, onAddComment, replyDraft, replyTargetCommentId]);

  const activeReplyComposer = useMemo<ReplyComposerState>(() => ({
    draft: replyDraft,
    messageRef: replyMessageRef,
    onAuthorChange: (author) => setReplyDraft((current) => ({ ...current, author })),
    onInterruptChange: (interruptAgent) => setReplyDraft((current) => ({ ...current, interruptAgent })),
    onMessageChange: (message) => setReplyDraft((current) => ({ ...current, message })),
    onSubmit: () => void handleAddReply(),
    onCancel: handleCancelReply,
  }), [handleAddReply, handleCancelReply, replyDraft]);

  return (
    <>
      <div className="task-detail-summary__history-header">
        <div>
          <p className="eyebrow">Discussion</p>
          <h4>Task conversation</h4>
        </div>
        <div className="transcript-event__meta-group">
          <span className="status-badge status-badge--neutral">{task.commentCount}</span>
          {shouldShowUnreadCommentAttention(task) ? (
            <span className="status-badge status-badge--warning status-badge--compact" data-role="task-unread-comments-footer-badge">
              {task.unreadCommentCount} unread
            </span>
          ) : null}
        </div>
      </div>

      <TaskCommentComposer
        author={commentDraft.author}
        authorDataRole="task-comment-author"
        tasks={tasks}
        agents={agents}
        roles={roles}
        currentTaskTags={currentTaskTags}
        message={commentMessage}
        messageDataRole="task-comment-message"
        messageLabel="Add comment"
        mentionListDataRole="task-comment-mention-list"
        mentionOptionDataRole="task-comment-mention-option"
        onAuthorChange={handleTopLevelCommentAuthorChange}
        onInterruptChange={handleTopLevelCommentInterruptChange}
        onMessageChange={setCommentMessage}
        onSubmit={() => void handleAddTopLevelComment()}
        rows={4}
        submitDataRole="add-task-comment"
        submitLabel="Add comment"
        taskId={task.id}
        interruptChecked={commentDraft.interruptAgent}
        interruptDataRole="task-comment-interrupt"
      />

      {commentThreads.length ? (
        <div className="task-section-list" data-role="task-comments">
          {commentThreads.map((thread) => (
            <TaskCommentThreadItem
              key={thread.comment.id}
              thread={thread}
              defaultFile={defaultFile}
              taskId={task.id}
              currentTaskTags={currentTaskTags}
              fileReferences={task.fileReferences}
              tasks={tasks}
              agents={agents}
              roles={roles}
              deleteAction={taskCommentDeleteAction}
              onOpenFileReference={onOpenFileReference}
              onOpenTask={onOpenTask}
              onOpenAgent={onOpenAgent}
              onOpenRole={onOpenRole}
              onDeleteComment={onDeleteComment}
              onReply={openReplyComposer}
              replyComposer={replyTargetCommentId === thread.comment.id ? activeReplyComposer : null}
            />
          ))}
        </div>
      ) : <p className="muted-copy">No comments yet. Add one to capture guidance, review notes, or an interrupt request.</p>}
    </>
  );
}
