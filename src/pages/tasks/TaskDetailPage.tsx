import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import hljs from "highlight.js";
import type { AgentSummary, MailboxMessage, RepositoryRecord, RoleSummary, TaskComment, TaskCommentInput, TaskDetail, TaskFileReference, TaskFileReferenceInput, TaskSummary, TaskTodo, TaskUpsertInput, WorkflowSummary } from "../../types";
import { useTaskFileContent } from "../../lib/orchestraData/tasks";
import { buildTaskCommentThreads, sortTaskCommentThreadsByLatestActivityDesc } from "../../lib/taskCommentThreads";
import { useExplanatoryTooltipProps } from "../../lib/tooltips";
import { shouldShowUnreadCommentAttention } from "../../lib/taskUnreadCommentVisibility";
import { TaskActionMenu, type TaskActionMenuAction } from "../../components/TaskActionMenu";
import { CommentableFileViewer } from "../../components/CommentableFileViewer";
import { MarkdownContent } from "../../components/MarkdownContent";
import { TaskCommentComposer } from "../../components/TaskCommentComposer";
import { TaskCommentMessage } from "../../components/TaskCommentMessage";
import { TaskEditorForm } from "./TaskEditorForm";
import { getTaskTags } from "../../lib/taskListQuery";
import { getEffectiveTaskDetailAssignmentStatus } from "./taskDetailActionState";
import { buildTaskDetailHeaderActions } from "./taskDetailHeaderActions";
import { getTaskDependencyTreeBranchLabel, type TaskDependencyTreeNode } from "./taskDependencyTree";

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "file_reference" | "lane_run" | "dependency_in" | "dependency_out";
  title: string;
  description: string;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

interface RelaneTargetOption {
  id: string;
  name: string;
}

type TaskDetailMobileActionMenuEntry =
  | ({ kind: "action" } & TaskActionMenuAction)
  | {
      kind: "relane";
      id: string;
      label: string;
      lanes: RelaneTargetOption[];
      onChoose: (lane: RelaneTargetOption) => void;
      disabled?: boolean;
      tooltip?: string;
    }
  | {
      kind: "divider";
      id: string;
    };

type TaskDetailTab =
  | "runtime"
  | "hierarchy"
  | "dependencies"
  | "repo-files"
  | "attachments"
  | "todos"
  | "timeline"
  | "history";

type TaskDetailNavItem = "details" | "comments" | TaskDetailTab;

type TaskDependencyViewMode = "list" | "tree";

interface TaskDetailPageProps {
  task: TaskDetail;
  draft: TaskUpsertInput;
  commentDraft: TaskCommentInput;
  fileReferenceDraft: TaskFileReferenceInput;
  dependencyTree: TaskDependencyTreeNode | null;
  dependencyTreeLoading: boolean;
  dependencyViewMode: TaskDependencyViewMode;
  tasks: TaskSummary[];
  workflows: WorkflowSummary[];
  workflowLanes: Array<{ id: string; name: string }>;
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
  closing: boolean;
  loading: boolean;
  sendingMail?: boolean;
  pendingActionId?: string | null;
  onDraftChange: (draft: TaskUpsertInput) => void;
  onCommentDraftChange: (draft: TaskCommentInput) => void;
  onCommentsTabViewed: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onPublish: () => void;
  onClose: (reason?: string) => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenTag: (tag: string) => void;
  onOpenSession: (sessionId: string, projectId?: string | null) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onDispatch: () => void;
  onRetry: () => void;
  onPauseRuntime: () => void;
  onWhipTask: () => void;
  onResetTask: () => void;
  onRelane: (laneId: string, notes?: string) => void;
  onComplete: (outcome: "success" | "failure" | "needs_user") => void;
  onApproveCompletion: () => void;
  onSendBackForWork: () => void;
  onAddDependency: () => void;
  onRemoveDependency: (dependencyId: string) => void;
  onSelectBlocker: (taskId: string) => void;
  onAddAttachment: (files: FileList | null) => void;
  onDownloadAttachment: (attachmentId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onFileReferenceDraftChange: (draft: TaskFileReferenceInput) => void;
  onDependencyViewModeChange: (mode: TaskDependencyViewMode) => void;
  onAddFileReference: () => void;
  onRemoveFileReference: (referenceId: string) => void;
  onSetDefaultFileReference: (referenceId: string) => void;
  onAddTaskTodo: (description: string, laneId: string) => void;
  onMarkTaskTodoFinished: (todoId: string) => void;
  onMarkTaskTodoUnfinished: (todoId: string) => void;
  onDeleteTaskTodo: (todoId: string) => void;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onUpdateComment: (commentId: string, message: string) => Promise<boolean>;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onSendMail: (body: string, interrupt: boolean) => Promise<void>;
  onEditingStateChange?: (editing: boolean) => void;
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

function describeTaskDependencyTreeMeta(task: TaskSummary, parent: TaskSummary | null) {
  return [task.priority, task.type, parent ? `Parent: ${parent.number}` : null].filter(Boolean).join(" · ");
}

function TaskDependencyTreeCard({
  node,
  onOpenTask,
  root = false,
}: {
  node: TaskDependencyTreeNode;
  onOpenTask: (taskId: string) => void;
  root?: boolean;
}) {
  const className = [
    "task-dependency-tree-card",
    root ? "task-dependency-tree-card--root" : null,
    node.reference ? "task-dependency-tree-card--reference" : null,
  ].filter(Boolean).join(" ");

  return (
    <div className="task-dependency-tree-node" data-role={root ? "task-dependency-tree-root" : "task-dependency-tree-node"}>
      <button className={className} type="button" onClick={() => onOpenTask(node.task.id)}>
        <div className="workflow-section__header">
          <strong>{node.task.number} · {node.task.title}</strong>
          <span className={`status-badge status-badge--${getStatusTone(node.task.status)}`}>{formatStatusLabel(node.task.status)}</span>
        </div>
        <p className="muted-copy">{describeTaskDependencyTreeMeta(node.task, node.parent)}</p>
        {node.reference ? <p className="supporting-copy">Referenced elsewhere in this tree.</p> : null}
      </button>
      {node.reference || !node.branches.length ? null : (
        <div className="task-dependency-tree-branches">
          {node.branches.map((branch) => (
            <section className="task-dependency-tree-branch" key={`${node.task.id}-${branch.type}`}>
              <p className="eyebrow">{getTaskDependencyTreeBranchLabel(branch.type)}</p>
              <div className="task-dependency-tree-branch__children">
                {branch.nodes.map((childNode) => (
                  <TaskDependencyTreeCard key={`${node.task.id}-${branch.type}-${childNode.task.id}`} node={childNode} onOpenTask={onOpenTask} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRelaneMenu({
  lanes,
  disabled = false,
  onChoose,
}: {
  lanes: RelaneTargetOption[];
  disabled?: boolean;
  onChoose: (lane: RelaneTargetOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!lanes.length || disabled) {
      setOpen(false);
    }
  }, [disabled, lanes.length]);

  if (!lanes.length) {
    return null;
  }

  return (
    <div className="task-relane-menu" ref={rootRef}>
      <button
        className="secondary-button task-relane-menu__trigger"
        data-role="toggle-task-relane"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        {...getTooltipProps("Move this task into a different workflow lane and optionally leave a note about why.")}
        onClick={() => setOpen((current) => !current)}
      >
        Re-lane
      </button>
      {open ? (
        <div className="task-relane-menu__dropdown" data-role="task-relane-menu" role="menu">
          {lanes.map((lane) => (
            <button
              key={lane.id}
              className="secondary-button task-relane-menu__option"
              data-role="task-relane-option"
              data-lane-id={lane.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChoose(lane);
              }}
            >
              <strong>{lane.name}</strong>
              <span className="muted-copy">{lane.id}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskDetailMobileActionMenu({
  entries,
  menuLabel = "Actions",
  pendingActionId = null,
}: {
  entries: TaskDetailMobileActionMenuEntry[];
  menuLabel?: string;
  pendingActionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [activeRelaneEntryId, setActiveRelaneEntryId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActiveRelaneEntryId(null);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setActiveRelaneEntryId(null);
    }
  }, [open]);

  useEffect(() => {
    if (pendingActionId) {
      setOpen(false);
      setActiveRelaneEntryId(null);
    }
  }, [pendingActionId]);

  const activeRelaneEntry = activeRelaneEntryId
    ? entries.find((entry): entry is Extract<TaskDetailMobileActionMenuEntry, { kind: "relane" }> => entry.kind === "relane" && entry.id === activeRelaneEntryId) ?? null
    : null;

  function getActionButtonClass(action: TaskActionMenuAction) {
    return `${
      action.variant === "primary"
        ? "primary-button task-action-menu__dropdown-button"
        : action.variant === "danger"
          ? "secondary-button secondary-button--danger task-action-menu__dropdown-button"
          : "secondary-button task-action-menu__dropdown-button"
    }${pendingActionId === action.id ? " task-action-button--pending" : ""}`;
  }

  function renderActionButton(action: TaskActionMenuAction) {
    return (
      <button
        key={action.id}
        className={getActionButtonClass(action)}
        data-role={action.dataRole}
        disabled={Boolean(pendingActionId) || action.disabled}
        type="button"
        {...getTooltipProps(action.tooltip)}
        onClick={() => {
          setOpen(false);
          setActiveRelaneEntryId(null);
          action.onClick();
        }}
      >
        {action.label}
      </button>
    );
  }

  return (
    <div className="task-action-menu task-detail-mobile-action-menu" ref={rootRef}>
      <div className="task-action-menu__mobile" data-role="task-action-menu-mobile">
        <button
          className="secondary-button task-action-menu__trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          {menuLabel}
        </button>
        {open ? (
          <div className="task-action-menu__dropdown task-detail-mobile-action-menu__dropdown" role="menu">
            {activeRelaneEntry ? (
              <>
                <button
                  className="secondary-button task-action-menu__dropdown-button task-detail-mobile-action-menu__back"
                  data-role="task-relane-mobile-back"
                  type="button"
                  onClick={() => setActiveRelaneEntryId(null)}
                >
                  ← Back
                </button>
                {activeRelaneEntry.lanes.map((lane) => (
                  <button
                    key={lane.id}
                    className="secondary-button task-relane-menu__option task-detail-mobile-action-menu__lane-option"
                    data-role="task-relane-option"
                    data-lane-id={lane.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      setActiveRelaneEntryId(null);
                      activeRelaneEntry.onChoose(lane);
                    }}
                  >
                    <strong>{lane.name}</strong>
                    <span className="muted-copy">{lane.id}</span>
                  </button>
                ))}
              </>
            ) : (
              entries.map((entry) => {
                switch (entry.kind) {
                  case "divider":
                    return <div className="task-detail-mobile-action-menu__divider" key={entry.id} role="separator" />;
                  case "relane":
                    return (
                      <button
                        key={entry.id}
                        className="secondary-button task-action-menu__dropdown-button"
                        data-role="task-relane-mobile-trigger"
                        disabled={Boolean(pendingActionId) || entry.disabled || !entry.lanes.length}
                        type="button"
                        {...getTooltipProps(entry.tooltip)}
                        onClick={() => setActiveRelaneEntryId(entry.id)}
                      >
                        {entry.label}
                      </button>
                    );
                  default:
                    return renderActionButton(entry);
                }
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
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

function laneLabelForTodo(task: TaskDetail, todo: TaskTodo) {
  if (task.currentLaneId === todo.laneId) {
    return `${todo.laneId} · current lane`;
  }
  return todo.laneId;
}

function groupTodosByLane(task: TaskDetail) {
  const todosByLane = new Map<string, TaskTodo[]>();
  for (const todo of task.todos) {
    const group = todosByLane.get(todo.laneId) ?? [];
    group.push(todo);
    todosByLane.set(todo.laneId, group);
  }
  return Array.from(todosByLane.entries())
    .map(([laneId, todos]) => ({ laneId, todos }))
    .sort((left, right) => {
      if (left.laneId === task.currentLaneId) return -1;
      if (right.laneId === task.currentLaneId) return 1;
      return left.laneId.localeCompare(right.laneId);
    });
}

const TAB_OPTIONS: Array<{ id: TaskDetailTab; label: string }> = [
  { id: "runtime", label: "Runtime" },
  { id: "hierarchy", label: "Hierarchy" },
  { id: "dependencies", label: "Dependencies" },
  { id: "repo-files", label: "Repo files" },
  { id: "todos", label: "Todos" },
  { id: "attachments", label: "Attachments" },
  { id: "timeline", label: "Timeline" },
  { id: "history", label: "Lane history" },
];

const NAV_OPTIONS: Array<{ id: TaskDetailNavItem; label: string }> = [
  { id: "details", label: "Details" },
  { id: "comments", label: "Comments" },
  ...TAB_OPTIONS,
];

const DELETE_HOLD_MS = 2000;
const FLOATING_CHROME_SCROLL_EPSILON = 2;
const FLOATING_CHROME_DIRECTION_THRESHOLD = 28;

interface FloatingTaskChromeLayout {
  left: number;
  right: number;
  top: number;
}

export function TaskDetailPage({
  task,
  draft,
  commentDraft,
  fileReferenceDraft,
  dependencyTree,
  dependencyTreeLoading,
  dependencyViewMode,
  tasks,
  workflows,
  workflowLanes,
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
  closing,
  loading,
  sendingMail = false,
  pendingActionId = null,
  onDraftChange,
  onCommentDraftChange,
  onCommentsTabViewed,
  onSave,
  onCancelEdit,
  onPublish,
  onClose,
  onDelete,
  onOpenTask,
  onOpenTag,
  onOpenSession,
  onOpenAgent,
  onOpenRole,
  onDispatch,
  onRetry,
  onPauseRuntime,
  onWhipTask,
  onResetTask,
  onRelane,
  onComplete,
  onApproveCompletion,
  onSendBackForWork,
  onAddDependency,
  onRemoveDependency,
  onSelectBlocker,
  onAddAttachment,
  onDownloadAttachment,
  onRemoveAttachment,
  onFileReferenceDraftChange,
  onDependencyViewModeChange,
  onAddFileReference,
  onRemoveFileReference,
  onSetDefaultFileReference,
  onAddTaskTodo,
  onMarkTaskTodoFinished,
  onMarkTaskTodoUnfinished,
  onDeleteTaskTodo,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onSendMail,
  onEditingStateChange,
}: TaskDetailPageProps) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("repo-files");
  const [activeNavAnchor, setActiveNavAnchor] = useState<"details" | "comments" | null>("details");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closeReason, setCloseReason] = useState("");
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
  const getTaskFileContent = useTaskFileContent();
  const [todoDraftDescription, setTodoDraftDescription] = useState("");
  const [todoDraftLaneId, setTodoDraftLaneId] = useState<string>(task.currentLaneId ?? draft.currentLaneId ?? "");
  const [relaneConfirmTarget, setRelaneConfirmTarget] = useState<RelaneTargetOption | null>(null);
  const [relaneNotes, setRelaneNotes] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [pendingScrollReferenceId, setPendingScrollReferenceId] = useState<string | null>(null);
  const [pendingReplyFocusTargetId, setPendingReplyFocusTargetId] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState<number>(() => {
    if (typeof window === "undefined") {
      return 5;
    }
    const stored = Number(window.localStorage.getItem("orchestra.taskDetail.historyLimit") ?? "5");
    return [5, 10, 25].includes(stored) ? stored : 5;
  });
  const deleteHoldTimerRef = useRef<number | null>(null);
  const detailPageRef = useRef<HTMLDivElement | null>(null);
  const primaryHeaderRef = useRef<HTMLDivElement | null>(null);
  const compactHeaderSentinelRef = useRef<HTMLDivElement | null>(null);
  const tabDockRef = useRef<HTMLDivElement | null>(null);
  const tabBodyRef = useRef<HTMLDivElement | null>(null);
  const commentsSectionRef = useRef<HTMLElement | null>(null);
  const repoFilesPanelRef = useRef<HTMLElement | null>(null);
  const loadedFileContentPathRef = useRef<string | null>(null);
  const selectedFileReferenceCardRef = useRef<HTMLElement | null>(null);
  const replyMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMarkedCommentsReadKeyRef = useRef<string | null>(null);
  const [floatingChromeLayout, setFloatingChromeLayout] = useState<FloatingTaskChromeLayout | null>(null);
  const [compactHeaderEligible, setCompactHeaderEligible] = useState(false);
  const [compactHeaderShown, setCompactHeaderShown] = useState(false);
  const [tabDockShown, setTabDockShown] = useState(true);
  const getTooltipProps = useExplanatoryTooltipProps();

  const canPublish = task.status === "draft" && Boolean(draft.workflowId && draft.title.trim()) && !publishing && !saving && !loading;
  const taskHeading = draft.title.trim() || task.title;
  const commentThreads = sortTaskCommentThreadsByLatestActivityDesc(buildTaskCommentThreads(task.comments));
  const defaultFile = task.fileReferences.find((reference) => reference.isDefault) ?? task.fileReferences[0] ?? null;
  const defaultFileAbsolutePath = defaultFile?.exists ? defaultFile.absolutePath ?? null : null;
  const recentHistory = timelineItems.slice(0, historyLimit);
  const taskTags = getTaskTags(task);
  const todoGroups = groupTodosByLane(task);
  const availableRelaneTargets = workflowLanes.filter((lane) => lane.id !== task.currentLaneId);
  const canRelane = Boolean(task.currentLaneId) && availableRelaneTargets.length > 0 && !["draft", "completed", "canceled"].includes(task.status);
  const canClose = !["completed", "canceled"].includes(task.status);
  const activeNavItem: TaskDetailNavItem = activeNavAnchor ?? activeTab;
  const activeSessionId = task.activeLaneAssignment?.sessionId ?? null;
  const effectiveActiveLaneAssignmentStatus = getEffectiveTaskDetailAssignmentStatus(task);
  const currentLaneTodos = task.currentLaneId ? task.todos.filter((todo) => todo.laneId === task.currentLaneId) : [];
  const unfinishedCurrentLaneTodos = currentLaneTodos.filter((todo) => !todo.completed);

  useEffect(() => {
    return () => {
      if (deleteHoldTimerRef.current !== null) {
        window.clearTimeout(deleteHoldTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setShowDeleteConfirm(false);
    setShowCloseConfirm(false);
    setCloseReason("");
  }, [task.id, task.status]);

  useEffect(() => {
    onEditingStateChange?.(isEditing);
  }, [isEditing, onEditingStateChange]);

  useEffect(() => {
    setReplyTargetCommentId(null);
    setReplyDraft(createReplyDraft(commentDraft.author));
    setPendingReplyFocusTargetId(null);
    setMailDraft("");
    setMailInterrupt(false);
    setTodoDraftDescription("");
    setTodoDraftLaneId(task.currentLaneId ?? draft.currentLaneId ?? "");
    setRelaneConfirmTarget(null);
    setRelaneNotes("");
  }, [workflowLanes, draft.currentLaneId, task.currentLaneId, task.id]);

  useEffect(() => {
    if (!replyTargetCommentId) {
      setReplyDraft((current) => ({ ...current, author: commentDraft.author }));
    }
  }, [commentDraft.author, replyTargetCommentId]);

  useEffect(() => {
    if (activeNavItem !== "comments" || task.unreadCommentCount <= 0) {
      return;
    }
    const readKey = `${task.id}:${task.unreadCommentCount}`;
    if (lastMarkedCommentsReadKeyRef.current === readKey) {
      return;
    }
    lastMarkedCommentsReadKeyRef.current = readKey;
    onCommentsTabViewed();
  }, [activeNavItem, onCommentsTabViewed, task.id, task.unreadCommentCount]);

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
    if (activeTab !== "repo-files" || !pendingScrollReferenceId || pendingScrollReferenceId !== selectedFileReference) {
      return;
    }

    let timeoutId: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      repoFilesPanelRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      timeoutId = window.setTimeout(() => {
        selectedFileReferenceCardRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
        setPendingScrollReferenceId(null);
      }, 50);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeTab, pendingScrollReferenceId, selectedFileReference]);

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

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("orchestra.taskDetail.historyLimit", String(historyLimit));
    }
  }, [historyLimit]);

  useEffect(() => {
    setActiveNavAnchor("details");
  }, [task.id]);

  useEffect(() => {
    const detailPage = detailPageRef.current;
    const tabBody = tabBodyRef.current;
    if (!detailPage || !tabBody || typeof window === "undefined") {
      return;
    }

    let scrollRoot: HTMLElement | null = null;
    let currentAncestor = detailPage.parentElement;
    while (currentAncestor) {
      const styles = window.getComputedStyle(currentAncestor);
      if (["auto", "scroll", "overlay"].includes(styles.overflowY)) {
        scrollRoot = currentAncestor;
        break;
      }
      currentAncestor = currentAncestor.parentElement;
    }

    const syncActiveNavAnchor = () => {
      const activationThreshold = (tabDockRef.current?.getBoundingClientRect().bottom ?? 0) + 40;
      if (tabBody.getBoundingClientRect().top <= activationThreshold) {
        setActiveNavAnchor((current) => (current === null ? current : null));
        return;
      }

      const commentsSection = commentsSectionRef.current;
      if (commentsSection) {
        const commentsRect = commentsSection.getBoundingClientRect();
        const commentsActive = commentsRect.top <= activationThreshold && commentsRect.bottom > activationThreshold;
        if (commentsActive) {
          setActiveNavAnchor((current) => (current === "comments" ? current : "comments"));
          return;
        }
      }

      setActiveNavAnchor((current) => (current === "details" ? current : "details"));
    };

    syncActiveNavAnchor();
    scrollRoot?.addEventListener("scroll", syncActiveNavAnchor, { passive: true });
    window.addEventListener("scroll", syncActiveNavAnchor, { passive: true });
    window.addEventListener("resize", syncActiveNavAnchor);

    return () => {
      scrollRoot?.removeEventListener("scroll", syncActiveNavAnchor);
      window.removeEventListener("scroll", syncActiveNavAnchor);
      window.removeEventListener("resize", syncActiveNavAnchor);
    };
  }, [activeTab, floatingChromeLayout, task.id]);

  useEffect(() => {
    const detailPage = detailPageRef.current;
    const primaryHeader = primaryHeaderRef.current;
    const sentinel = compactHeaderSentinelRef.current;
    if (!detailPage || !primaryHeader || !sentinel || typeof window === "undefined") {
      setFloatingChromeLayout(null);
      setCompactHeaderEligible(false);
      setCompactHeaderShown(false);
      setTabDockShown(true);
      return;
    }

    let scrollRoot: HTMLElement | null = null;
    let currentAncestor = detailPage.parentElement;
    while (currentAncestor) {
      const styles = window.getComputedStyle(currentAncestor);
      if (["auto", "scroll", "overlay"].includes(styles.overflowY)) {
        scrollRoot = currentAncestor;
        break;
      }
      currentAncestor = currentAncestor.parentElement;
    }
    const contentRoot = detailPage.closest(".content") as HTMLElement | null;
    const mobileTopbar = document.querySelector('[data-role="mobile-topbar"]') as HTMLElement | null;
    scrollRoot?.scrollTo({ top: 0, behavior: "auto" });
    window.scrollTo({ top: 0, behavior: "auto" });
    setCompactHeaderEligible(false);
    setCompactHeaderShown(false);
    setTabDockShown(true);
    let frameId: number | null = null;
    const getScrollPosition = () => Math.max(scrollRoot?.scrollTop ?? 0, window.scrollY, detailPage.ownerDocument.documentElement.scrollTop);
    let lastScrollPosition = getScrollPosition();
    let accumulatedDirection: "up" | "down" | null = null;
    let accumulatedDistance = 0;
    let pendingScrollIntent: "up" | "down" | null = null;

    const updateFloatingChrome = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const detailRect = detailPage.getBoundingClientRect();
        const contentRect = contentRoot?.getBoundingClientRect() ?? null;
        const topbarRect = mobileTopbar?.getBoundingClientRect() ?? null;
        const pinnedTop = Math.max(contentRect?.top ?? 0, topbarRect?.bottom ?? 0, 0) + 10;
        const nextLayout = detailRect.width > 0 && detailRect.bottom > pinnedTop + 72
          ? {
              left: Math.max(detailRect.left, 12),
              right: Math.max(window.innerWidth - detailRect.right, 12),
              top: pinnedTop,
            }
          : null;
        const scrollPosition = getScrollPosition();
        const nextEligible = scrollPosition > 120 && sentinel.getBoundingClientRect().top <= pinnedTop + 4;

        setFloatingChromeLayout((current) => {
          if (!nextLayout && !current) {
            return current;
          }
          if (
            current
            && nextLayout
            && current.left === nextLayout.left
            && current.right === nextLayout.right
            && current.top === nextLayout.top
          ) {
            return current;
          }
          return nextLayout;
        });

        if (!nextLayout || !nextEligible) {
          accumulatedDirection = null;
          accumulatedDistance = 0;
          pendingScrollIntent = null;
          lastScrollPosition = scrollPosition;
          setCompactHeaderEligible((current) => (current ? false : current));
          setCompactHeaderShown((current) => (current ? false : current));
          setTabDockShown((current) => (current === true ? current : true));
          return;
        }

        setCompactHeaderEligible((current) => (current === nextEligible ? current : nextEligible));

        if (pendingScrollIntent) {
          const nextShown = pendingScrollIntent === "up";
          pendingScrollIntent = null;
          setCompactHeaderShown((current) => (current === nextShown ? current : nextShown));
          setTabDockShown((current) => (current === nextShown ? current : nextShown));
        }
      });
    };

    updateFloatingChrome();
    const handleScroll = () => {
      const scrollPosition = getScrollPosition();
      const delta = scrollPosition - lastScrollPosition;
      lastScrollPosition = scrollPosition;

      if (Math.abs(delta) >= FLOATING_CHROME_SCROLL_EPSILON) {
        const nextDirection = delta > 0 ? "down" : "up";
        if (accumulatedDirection !== nextDirection) {
          accumulatedDirection = nextDirection;
          accumulatedDistance = Math.abs(delta);
        } else {
          accumulatedDistance += Math.abs(delta);
        }

        if (accumulatedDistance >= FLOATING_CHROME_DIRECTION_THRESHOLD) {
          pendingScrollIntent = nextDirection;
          accumulatedDistance = 0;
        }
      }

      updateFloatingChrome();
    };
    const handleMeasure = () => updateFloatingChrome();
    scrollRoot?.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      scrollRoot?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleMeasure);
    };
  }, [task.id]);

  useEffect(() => {
    if (!defaultFileAbsolutePath) {
      setDefaultFileContent(null);
      setLoadingDefaultFileContent(false);
      return;
    }
    let canceled = false;
    setLoadingDefaultFileContent(true);
    getTaskFileContent(defaultFileAbsolutePath)
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
  }, [defaultFileAbsolutePath, getTaskFileContent]);

  async function loadFileContent(reference: TaskFileReference) {
    if (!reference.exists || !reference.absolutePath) {
      loadedFileContentPathRef.current = null;
      setFileContent(null);
      setLoadingFileContent(false);
      return;
    }
    if (loadedFileContentPathRef.current === reference.absolutePath) {
      return;
    }
    setLoadingFileContent(true);
    try {
      const content = await getTaskFileContent(reference.absolutePath);
      loadedFileContentPathRef.current = reference.absolutePath;
      setFileContent(content);
    } catch (error) {
      console.error("Failed to load file content:", error);
      loadedFileContentPathRef.current = null;
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

  const headerActionMenuActions = buildTaskDetailHeaderActions({
    task,
    canPublish,
    effectiveActiveLaneAssignmentStatus,
    onPublish,
    onDispatch,
    onApproveCompletion,
    onSendBackForWork,
    onResetTask,
    onComplete,
    onPauseRuntime,
    onWhipTask,
  });

  function clearDeleteHold() {
    if (deleteHoldTimerRef.current !== null) {
      window.clearTimeout(deleteHoldTimerRef.current);
      deleteHoldTimerRef.current = null;
    }
    setDeleteHolding(false);
  }

  function handleDeletePointerDown() {
    if (deleting || closing) {
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

  function openReplyComposer(threadComment: TaskComment) {
    setReplyTargetCommentId(threadComment.id);
    setReplyDraft(createReplyDraft(commentDraft.author, threadComment.id));
    setPendingReplyFocusTargetId(threadComment.id);
  }

  function handleCancelEdit() {
    onCancelEdit();
    setIsEditing(false);
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
    setPendingReplyFocusTargetId(null);
  }

  async function handleSendRuntimeMail() {
    if (!mailDraft.trim()) {
      return;
    }
    await onSendMail(mailDraft, mailInterrupt);
    setMailDraft("");
    setMailInterrupt(false);
  }

  function handleAddTodo() {
    if (!todoDraftDescription.trim() || !todoDraftLaneId) {
      return;
    }
    onAddTaskTodo(todoDraftDescription, todoDraftLaneId);
    setTodoDraftDescription("");
  }

  function openRelaneConfirm(lane: RelaneTargetOption) {
    setRelaneConfirmTarget(lane);
    setRelaneNotes("");
  }

  function handleRelaneSubmit() {
    if (!relaneConfirmTarget) {
      return;
    }
    onRelane(relaneConfirmTarget.id, relaneNotes.trim() || undefined);
    setRelaneConfirmTarget(null);
    setRelaneNotes("");
  }

  function selectTaskDetailTab(tabId: TaskDetailTab) {
    setActiveNavAnchor(null);
    setActiveTab(tabId);
  }

  function handleOpenCommentFileReference(reference: TaskFileReference) {
    setPendingScrollReferenceId(reference.id);
    selectTaskDetailTab("repo-files");
    setSelectedFileReference(reference.id);
    loadFileContent(reference);
    window.requestAnimationFrame(() => {
      tabBodyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  function handleScrollToTaskDetails() {
    setActiveNavAnchor("details");
    window.requestAnimationFrame(() => {
      primaryHeaderRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  function handleScrollToTaskComments() {
    setActiveNavAnchor("comments");
    window.requestAnimationFrame(() => {
      commentsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  function handleTabSelect(tabId: TaskDetailTab) {
    selectTaskDetailTab(tabId);
    window.requestAnimationFrame(() => {
      tabBodyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
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
              <TaskActionMenu actions={headerActionMenuActions} menuLabel="Lane actions" pendingActionId={pendingActionId} />
            </div>
            {task.activeLaneAssignment ? (
              <div className="task-runtime-card" data-role="task-runtime-assignment">
                <div className="workflow-section__header">
                  <strong>{task.activeLaneAssignment.workerType} · {task.activeLaneAssignment.workerId ?? "unassigned"}</strong>
                  <span className={`status-badge status-badge--${effectiveActiveLaneAssignmentStatus === "active" ? "success" : effectiveActiveLaneAssignmentStatus === "queued" ? "warning" : "neutral"}`}>
                    {effectiveActiveLaneAssignmentStatus ?? task.activeLaneAssignment.status}
                  </span>
                </div>
                <div className="workforce-meta-grid muted-copy">
                  <span>Lane: {task.activeLaneAssignment.laneId}</span>
                  <span>Session: {task.activeLaneAssignment.sessionId ?? "—"}</span>
                  <span>Runtime cwd: {task.activeLaneAssignment.runtimeCwd ?? "—"}</span>
                  <span>Whips: {task.activeLaneAssignment.whipCount ?? 0} / {task.whipMaxAttempts ?? 10}</span>
                  <span>Last whip: {task.activeLaneAssignment.lastWhipAt ?? "—"}</span>
                </div>
                {effectiveActiveLaneAssignmentStatus === "awaiting_user_approval" ? (
                  <p className="muted-copy" data-role="task-awaiting-approval-note">
                    This lane reported success and is paused for user approval before the workflow continues.
                    {task.activeLaneAssignment.completionNotes ? ` Worker notes: ${task.activeLaneAssignment.completionNotes}` : ""}
                  </p>
                ) : null}
                {effectiveActiveLaneAssignmentStatus === "awaiting_user_intervention" ? (
                  <p className="muted-copy" data-role="task-awaiting-user-intervention-note">
                    This lane asked for user intervention and is paused until you decide how to continue it.
                    {task.activeLaneAssignment.completionNotes ? ` Worker notes: ${task.activeLaneAssignment.completionNotes}` : ""}
                  </p>
                ) : null}
                {effectiveActiveLaneAssignmentStatus === "paused_by_user" ? (
                  <p className="muted-copy" data-role="task-paused-by-user-note">
                    This lane was paused by a user or operator. Resume keeps the current lane active, while Stop ends the current assignment and returns the task to a same-lane ready state.
                    {task.activeLaneAssignment.completionNotes ? ` Notes: ${task.activeLaneAssignment.completionNotes}` : ""}
                  </p>
                ) : null}
                <div className="action-cluster">
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role="reset-task-runtime"
                    type="button"
                    disabled={Boolean(pendingActionId)}
                    {...getTooltipProps("End the current assignment and return this task to a ready state.")}
                    onClick={onResetTask}
                  >
                    Stop current work
                  </button>
                </div>

                <div className="task-section-list">
                  <article className="task-history-card">
                    <div className="workflow-section__header">
                      <strong>Send mail to active worker</strong>
                      <span className="status-badge status-badge--neutral">Mailbox</span>
                    </div>
                    <p className="supporting-copy">Send a mailbox message to the active worker for this lane.</p>
                    <label className="field-group" {...getTooltipProps("Write a mailbox message for the worker currently assigned to this lane.")}>
                      <span className="field-group__label">Message</span>
                      <textarea className="text-area" data-role="task-runtime-mail-body" rows={4} value={mailDraft} onChange={(event) => setMailDraft(event.target.value)} />
                    </label>
                    <label className="checkbox-field" {...getTooltipProps("Send this as an interrupt instead of a normal mailbox message.")}>
                      <input data-role="task-runtime-mail-interrupt" type="checkbox" checked={mailInterrupt} onChange={(event) => setMailInterrupt(event.target.checked)} />
                      <span>Interrupt worker immediately</span>
                    </label>
                    <div className="action-cluster">
                      <button
                        className="primary-button"
                        data-role="task-runtime-send-mail"
                        type="button"
                        disabled={sendingMail || !mailDraft.trim()}
                        {...getTooltipProps("Deliver this message to the active worker session for the current lane.")}
                        onClick={() => void handleSendRuntimeMail()}
                      >
                        {sendingMail ? "Sending…" : "Send mail"}
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            ) : (
              <div className="task-section-list">
                <p className="supporting-copy">No active runtime assignment for this task.</p>
              </div>
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
              <p className="supporting-copy">No parent task.</p>
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
              <div className="task-dependency-header-controls">
                <div className="task-view-toggle" data-role="task-dependency-view-toggle">
                  <button
                    className={dependencyViewMode === "list" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
                    data-role="task-dependency-view-list"
                    type="button"
                    aria-pressed={dependencyViewMode === "list"}
                    onClick={() => onDependencyViewModeChange("list")}
                  >
                    <span aria-hidden="true">☰</span>
                    <span>List</span>
                  </button>
                  <button
                    className={dependencyViewMode === "tree" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
                    data-role="task-dependency-view-tree"
                    type="button"
                    aria-pressed={dependencyViewMode === "tree"}
                    onClick={() => onDependencyViewModeChange("tree")}
                  >
                    <span aria-hidden="true">⋮</span>
                    <span>Tree</span>
                  </button>
                </div>
                <div className="task-dependency-actions">
                  <select
                    className="select-input"
                    data-role="dependency-blocker-select"
                    value={selectedBlockerTaskId}
                    {...getTooltipProps("Choose a task that must finish before this one can continue.")}
                    onChange={(event) => onSelectBlocker(event.target.value)}
                  >
                    <option value="">Select blocker task…</option>
                    {dependencyCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.number} · {candidate.title}</option>
                    ))}
                  </select>
                  <button
                    className="secondary-button"
                    data-role="add-dependency"
                    type="button"
                    disabled={!selectedBlockerTaskId}
                    {...getTooltipProps("Link the selected task as a blocker for this one.")}
                    onClick={onAddDependency}
                  >Add dependency</button>
                </div>
              </div>
            </div>

            {task.dependencyBlocked ? <p className="error-copy">This task is currently blocked by unresolved dependencies or unfinished subtasks and is not dispatchable.</p> : null}
            {dependencyViewMode === "list" ? (
              <div className="task-dependency-grid" data-role="task-dependency-list">
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
                  ) : <p className="supporting-copy">No blockers linked.</p>}
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
                          <p className="supporting-copy">Blocked until this task is resolved.</p>
                        </article>
                      ))}
                    </div>
                  ) : <p className="supporting-copy">No downstream blocked tasks.</p>}
                </div>
              </div>
            ) : (
              <div className="task-dependency-tree" data-role="task-dependency-tree">
                <p className="supporting-copy">Tree view is optimized for scanning dependency chains. Switch back to list view to remove specific direct dependency links.</p>
                {dependencyTreeLoading ? (
                  <p className="supporting-copy">Loading dependency tree…</p>
                ) : dependencyTree ? (
                  <TaskDependencyTreeCard node={dependencyTree} onOpenTask={onOpenTask} root />
                ) : (
                  <p className="supporting-copy">Unable to build the dependency tree right now.</p>
                )}
              </div>
            )}
          </section>
        );
      case "repo-files":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-repo-files" ref={repoFilesPanelRef}>
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Repo files</p>
                <h4>Tracked repo files</h4>
                <p className="supporting-copy">Track important non-source files here when they should stay visible on the task.</p>
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
              <p className="supporting-copy">No repositories linked to this task.</p>
            )}

            <div className="task-editor-grid">
              <label className="field-group" {...getTooltipProps("Choose which task repository owns the file you want to track here.")}>
                <span className="field-group__label">Repository</span>
                <select className="select-input" data-role="task-file-reference-repository" value={fileReferenceDraft.repositoryId} onChange={(event) => onFileReferenceDraftChange({ ...fileReferenceDraft, repositoryId: event.target.value })}>
                  <option value="">Select repository…</option>
                  {repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>{repository.name}</option>
                  ))}
                </select>
              </label>
              <label className="field-group" {...getTooltipProps("Enter the repository-relative path for the file you want to keep visible on this task.")}>
                <span className="field-group__label">Relative path</span>
                <input className="text-input" data-role="task-file-reference-path" value={fileReferenceDraft.relativePath} onChange={(event) => onFileReferenceDraftChange({ ...fileReferenceDraft, relativePath: event.target.value })} placeholder="docs/design.md" />
              </label>
              <div className="task-editor-grid__full">
                <button
                  className="secondary-button"
                  data-role="add-task-file-reference"
                  type="button"
                  disabled={!fileReferenceDraft.repositoryId || !fileReferenceDraft.relativePath.trim()}
                  {...getTooltipProps("Track this repository file on the task so workers and reviewers can find it quickly.")}
                  onClick={onAddFileReference}
                >Add file reference</button>
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
                    <article
                      className="task-history-card task-history-card--file-reference"
                      data-role={reference.id === selectedFileReference ? "selected-task-file-reference-card" : undefined}
                      key={reference.id}
                      ref={(element) => {
                        if (reference.id === selectedFileReference) {
                          selectedFileReferenceCardRef.current = element;
                        }
                      }}
                    >
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
                      <p className="supporting-copy">
                        This file is missing from the resolved repository or task worktree. It may have moved, been deleted, or the worktree may not be materialized yet.
                      </p>
                    </div>
                  );
                })()}
              </div>
            ) : <p className="supporting-copy">No tracked repo files yet.</p>}
          </section>
        );
      case "todos":
        return (
          <section className="task-section" data-role="task-detail-tabpanel-todos">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Todos</p>
                <h4>Lane checklist items</h4>
              </div>
            </div>

            {unfinishedCurrentLaneTodos.length ? (
              <p className="error-copy" data-role="task-current-lane-todo-warning">
                {unfinishedCurrentLaneTodos.length} unfinished todo{unfinishedCurrentLaneTodos.length === 1 ? "" : "s"} remain for the current lane. Orchestra will block lane transitions until they are completed.
              </p>
            ) : null}

            <div className="task-history-card" data-role="task-todo-composer">
              <div className="task-detail-summary__history-header">
                <div>
                  <p className="eyebrow">Add todo</p>
                  <h4>Create a lane-scoped checklist item</h4>
                </div>
              </div>
              <div className="field-grid field-grid--two-column">
                <label className="field-group" {...getTooltipProps("Choose which workflow lane should own this checklist item.")}>
                  <span className="field-group__label">Lane</span>
                  <select className="select-input" data-role="task-todo-lane" value={todoDraftLaneId} onChange={(event) => setTodoDraftLaneId(event.target.value)}>
                    <option value="">Select a lane</option>
                    {workflowLanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name} · {lane.id}</option>
                    ))}
                  </select>
                </label>
                <label className="field-group field-group--full-width" {...getTooltipProps("Describe the follow-up work that should stay visible on this task.")}>
                  <span className="field-group__label">Description</span>
                  <input className="text-input" data-role="task-todo-description" type="text" value={todoDraftDescription} onChange={(event) => setTodoDraftDescription(event.target.value)} placeholder="Describe the follow-up item for this lane" />
                </label>
              </div>
              <div className="action-cluster action-cluster--wrap">
                <button
                  className="secondary-button"
                  data-role="add-task-todo"
                  type="button"
                  disabled={!todoDraftDescription.trim() || !todoDraftLaneId}
                  {...getTooltipProps("Add a lane-scoped checklist item that must be tracked to completion.")}
                  onClick={handleAddTodo}
                >Add todo</button>
              </div>
            </div>

            {todoGroups.length ? (
              <div className="task-section-list" data-role="task-todo-groups">
                {todoGroups.map((group) => (
                  <article className="task-history-card" data-role="task-todo-group" data-lane-id={group.laneId} key={group.laneId}>
                    <div className="workflow-section__header">
                      <strong>{group.laneId}</strong>
                      <span className={`status-badge status-badge--${group.laneId === task.currentLaneId ? "accent" : "neutral"}`}>
                        {group.laneId === task.currentLaneId ? "current lane" : `${group.todos.filter((todo) => !todo.completed).length} open`}
                      </span>
                    </div>
                    <div className="task-section-list" data-role="task-todos">
                      {group.todos.map((todo) => (
                        <article className="task-history-card" data-role="task-todo-item" data-todo-id={todo.id} key={todo.id}>
                          <div className="workflow-section__header">
                            <div>
                              <strong>{todo.description}</strong>
                              <p className="muted-copy">{laneLabelForTodo(task, todo)}</p>
                            </div>
                            <span className={`status-badge status-badge--${todo.completed ? "success" : "warning"}`}>{todo.completed ? "finished" : "unfinished"}</span>
                          </div>
                          <div className="action-cluster action-cluster--wrap">
                            {todo.completed ? (
                              <button className="secondary-button" data-role="mark-task-todo-unfinished" type="button" onClick={() => onMarkTaskTodoUnfinished(todo.id)}>
                                Mark unfinished
                              </button>
                            ) : (
                              <button className="secondary-button" data-role="mark-task-todo-finished" type="button" onClick={() => onMarkTaskTodoFinished(todo.id)}>
                                Mark finished
                              </button>
                            )}
                            <button className="secondary-button secondary-button--danger" data-role="delete-task-todo" type="button" onClick={() => onDeleteTaskTodo(todo.id)}>
                              Delete
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="supporting-copy">No todos yet.</p>}
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
                      <div className="button-row">
                        <button className="secondary-button" data-attachment-id={attachment.id} data-role="download-task-attachment" type="button" onClick={() => onDownloadAttachment(attachment.id)}>Download</button>
                        <button className="secondary-button secondary-button--danger" type="button" onClick={() => onRemoveAttachment(attachment.id)}>Remove</button>
                      </div>
                    </div>
                    <p className="muted-copy">{attachment.mediaType} · {Math.max(1, Math.round(attachment.byteSize / 1024))} KB</p>
                    {attachment.imageDataUrl ? <img alt={attachment.fileName} className="task-attachment-card__image" src={attachment.imageDataUrl} /> : null}
                    {attachment.previewText ? <pre className="task-attachment-card__text">{attachment.previewText}</pre> : null}
                  </article>
                ))}
              </div>
            ) : <p className="supporting-copy">No attachments yet.</p>}
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

  const taskHeaderMeta = [
    task.number,
    `${task.commentCount} comments`,
    `${task.todos.length} todos`,
    `${task.laneRunCount} lane runs`,
    task.childCount ? `${task.childCount} children` : null,
    task.attachmentCount ? `${task.attachmentCount} attachments` : null,
    task.blockedByCount ? `${task.blockedByCount} blockers` : null,
    task.readyForDispatch ? "Dispatchable" : "Not dispatchable",
  ].filter(Boolean);

  const stickyChromeStyle = floatingChromeLayout
    ? {
        left: `${floatingChromeLayout.left}px`,
        right: `${floatingChromeLayout.right}px`,
      }
    : undefined;
  const compactHeaderActionMenuActions = headerActionMenuActions.map((action) => ({ ...action, dataRole: undefined }));

  function buildMobileHeaderActionMenuEntries(actions: TaskActionMenuAction[]): TaskDetailMobileActionMenuEntry[] {
    const actionEntries: TaskDetailMobileActionMenuEntry[] = actions.map((action) => ({ kind: "action", ...action }));
    if (!canRelane || !availableRelaneTargets.length) {
      return actionEntries;
    }

    const relaneEntry: TaskDetailMobileActionMenuEntry = {
      kind: "relane",
      id: "mobile-relane",
      label: "Move to …",
      lanes: availableRelaneTargets,
      onChoose: openRelaneConfirm,
      disabled: Boolean(pendingActionId),
      tooltip: "Move this task into a different workflow lane and optionally leave a note about why.",
    };
    const dividerBefore: TaskDetailMobileActionMenuEntry = { kind: "divider", id: "mobile-relane-divider-before" };
    const dividerAfter: TaskDetailMobileActionMenuEntry = { kind: "divider", id: "mobile-relane-divider-after" };
    const preferredAnchorIds = new Set(["approve-pending", "needs-work-pending", "approve-user", "needs-work-user", "resume-pending"]);
    const trailingActionIds = new Set(["pause", "stop-pending-review", "stop-paused-lane", "stop-active-work", "whip"]);

    let insertAfterIndex = -1;
    actionEntries.forEach((entry, index) => {
      if (entry.kind === "action" && preferredAnchorIds.has(entry.id)) {
        insertAfterIndex = index;
      }
    });

    if (insertAfterIndex >= 0) {
      const tailEntries = actionEntries.slice(insertAfterIndex + 1);
      return [
        ...actionEntries.slice(0, insertAfterIndex + 1),
        dividerBefore,
        relaneEntry,
        ...(tailEntries.length ? [dividerAfter] : []),
        ...tailEntries,
      ];
    }

    const firstTrailingActionIndex = actionEntries.findIndex(
      (entry) => entry.kind === "action" && trailingActionIds.has(entry.id),
    );
    if (firstTrailingActionIndex >= 0) {
      return [
        ...actionEntries.slice(0, firstTrailingActionIndex),
        ...(firstTrailingActionIndex > 0 ? [dividerBefore] : []),
        relaneEntry,
        dividerAfter,
        ...actionEntries.slice(firstTrailingActionIndex),
      ];
    }

    return [...actionEntries, ...(actionEntries.length ? [dividerBefore] : []), relaneEntry];
  }

  const compactHeaderMobileActionMenuEntries = buildMobileHeaderActionMenuEntries(compactHeaderActionMenuActions);
  const primaryHeaderMobileActionMenuEntries = [
    ...buildMobileHeaderActionMenuEntries(headerActionMenuActions),
    ...(activeSessionId
      ? [
          ...(headerActionMenuActions.length ? [{ kind: "divider", id: "mobile-open-session-divider" } satisfies TaskDetailMobileActionMenuEntry] : []),
          {
            kind: "action",
            id: "open-session",
            label: "Open session",
            onClick: () => onOpenSession(activeSessionId, task.projectId),
            variant: "secondary" as const,
            dataRole: "task-open-session",
          } satisfies TaskDetailMobileActionMenuEntry,
        ]
      : []),
  ];

  function renderHeaderActions(compact = false) {
    const desktopActionMenuActions = compact ? compactHeaderActionMenuActions : headerActionMenuActions;
    const mobileActionMenuEntries = compact ? compactHeaderMobileActionMenuEntries : primaryHeaderMobileActionMenuEntries;
    const showDesktopActionRow = canRelane || desktopActionMenuActions.length > 0;
    const showDesktopHeaderActions = Boolean((!compact && activeSessionId) || showDesktopActionRow);

    if (!showDesktopHeaderActions && mobileActionMenuEntries.length === 0) {
      return null;
    }

    return (
      <div className="task-detail-header-actions">
        {showDesktopHeaderActions ? (
          <div className="task-detail-header-actions__desktop">
            {!compact && activeSessionId ? (
              <button
                className="secondary-button"
                data-role="task-open-session"
                type="button"
                onClick={() => onOpenSession(activeSessionId, task.projectId)}
              >
                Open session
              </button>
            ) : null}
            {showDesktopActionRow ? (
              <div
                className="action-cluster action-cluster--wrap task-detail-header-action-row"
                data-role={compact ? "task-detail-compact-actions" : "task-detail-primary-actions"}
              >
                {canRelane ? <TaskRelaneMenu lanes={availableRelaneTargets} disabled={Boolean(pendingActionId)} onChoose={openRelaneConfirm} /> : null}
                {desktopActionMenuActions.length ? (
                  <TaskActionMenu actions={desktopActionMenuActions} pendingActionId={pendingActionId} />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {mobileActionMenuEntries.length ? (
          <div
            className="task-detail-header-actions__mobile"
            data-role={compact ? "task-detail-compact-actions-mobile" : "task-detail-primary-actions-mobile"}
          >
            <TaskDetailMobileActionMenu entries={mobileActionMenuEntries} menuLabel="Actions" pendingActionId={pendingActionId} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="task-detail-shell" ref={detailPageRef}>
      <section className="task-page task-detail-page panel" data-role="task-detail-panel" data-task-id={task.id}>
        <div className="panel__header panel__header--session-detail task-detail-primary-header" data-role="task-detail-primary-header" ref={primaryHeaderRef}>
          <div className="task-detail-primary-header__copy">
            <h2 data-role="task-title-heading">{taskHeading}</h2>
            {taskTags.length ? (
              <div className="task-detail-primary-header__tags task-tag-list task-tag-list--readonly" data-role="task-title-tags" aria-label="Task tags">
                {taskTags.map((tag) => (
                  <button
                    aria-label={`Show tasks tagged ${tag}`}
                    className="task-tag-chip task-tag-chip--readonly task-tag-chip--interactive"
                    data-role="task-tag-chip"
                    data-tag-value={tag}
                    key={tag}
                    type="button"
                    onClick={() => onOpenTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="session-detail__meta">
              {taskHeaderMeta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>

          {renderHeaderActions()}
        </div>
        <div className="task-detail-primary-header-sentinel" ref={compactHeaderSentinelRef} aria-hidden="true" />

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
                    onClick: handleCancelEdit,
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
                  },
                  ...(canClose
                    ? [{
                        id: "close",
                        label: closing ? "Closing…" : "Close",
                        onClick: () => setShowCloseConfirm(true),
                        disabled: closing || deleting,
                        variant: "secondary" as const,
                        dataRole: "close-task",
                      }]
                    : []),
                  {
                    id: "delete",
                    label: deleting ? "Deleting…" : "Delete",
                    onClick: () => setShowDeleteConfirm(true),
                    disabled: deleting || closing,
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
                  ...(canClose
                    ? [{
                        id: "close",
                        label: closing ? "Closing…" : "Close",
                        onClick: () => setShowCloseConfirm(true),
                        disabled: closing || deleting,
                        variant: "secondary" as const,
                        dataRole: "close-task",
                      }]
                    : []),
                  {
                    id: "delete",
                    label: deleting ? "Deleting…" : "Delete",
                    onClick: () => setShowDeleteConfirm(true),
                    disabled: deleting || closing,
                    variant: "danger",
                    dataRole: "delete-task",
                  },
                ]}
                pendingActionId={pendingActionId}
              />
            </div>

            <div className="task-history-card" data-role="task-overview-description">
              <div className="workflow-section__header">
                <div>
                  <p className="eyebrow">Description</p>
                  <h4>Task description</h4>
                </div>
              </div>
              {task.description?.trim() ? (
                <MarkdownContent
                  className="task-detail-markdown markdown-content"
                  dataRole="task-description-markdown"
                  message={task.description}
                />
              ) : (
                <p>No description provided.</p>
              )}
            </div>

            {unfinishedCurrentLaneTodos.length ? (
              <section className="task-history-card" data-role="task-overview-todo-warning">
                <div className="workflow-section__header">
                  <div>
                    <p className="eyebrow">Current lane todos</p>
                    <h4>Remaining checklist items</h4>
                  </div>
                  <span className="status-badge status-badge--warning">{unfinishedCurrentLaneTodos.length} open</span>
                </div>
                <p className="error-copy">This lane still has unfinished todo items. Orchestra will block transitions until they are marked finished.</p>
                <ul className="task-detail-summary__history-list">
                  {unfinishedCurrentLaneTodos.map((todo) => (
                    <li key={todo.id}>{todo.description}</li>
                  ))}
                </ul>
              </section>
            ) : null}

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
                        tasks={tasks}
                        agents={agents}
                        roles={roles}
                        commentDraft={commentDraft}
                        comments={task.comments}
                        content={defaultFileContent ?? ""}
                        fileReferences={task.fileReferences}
                        language={detectLanguage(defaultFile.relativePath)}
                        onAddComment={onAddComment}
                        onCommentDraftChange={onCommentDraftChange}
                        onDeleteComment={onDeleteComment}
                        onOpenFileReference={handleOpenCommentFileReference}
                        onOpenTask={onOpenTask}
                        onOpenAgent={onOpenAgent}
                        onOpenRole={onOpenRole}
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

            <section className="task-detail-summary__comments task-history-card" data-role="task-detail-summary-comments" ref={commentsSectionRef}>
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
                message={commentDraft.message}
                messageDataRole="task-comment-message"
                messageLabel="Add comment"
                mentionListDataRole="task-comment-mention-list"
                mentionOptionDataRole="task-comment-mention-option"
                onAuthorChange={(author) => onCommentDraftChange({ ...commentDraft, author })}
                onInterruptChange={(interruptAgent) => onCommentDraftChange({ ...commentDraft, interruptAgent })}
                onMessageChange={(message) => onCommentDraftChange({ ...commentDraft, message })}
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
                          dataRole="task-comment-mention-link"
                          fileReferences={task.fileReferences}
                          tasks={tasks}
                          agents={agents}
                          roles={roles}
                          message={comment.message}
                          onOpenFileReference={handleOpenCommentFileReference}
                          onOpenTask={onOpenTask}
                          onOpenAgent={onOpenAgent}
                          onOpenRole={onOpenRole}
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
                                dataRole="task-comment-mention-link"
                                fileReferences={task.fileReferences}
                                tasks={tasks}
                                agents={agents}
                                roles={roles}
                                message={reply.message}
                                onOpenFileReference={handleOpenCommentFileReference}
                                onOpenTask={onOpenTask}
                                onOpenAgent={onOpenAgent}
                                onOpenRole={onOpenRole}
                              />
                              {reply.selectedText ? <pre className="task-comment-thread__quote">{reply.selectedText}</pre> : null}
                              <div className="task-comment-thread__actions">
                                <button className="secondary-button" data-role="reply-task-comment" data-comment-id={reply.id} data-parent-comment-id={comment.id} type="button" onClick={() => openReplyComposer(comment)}>
                                  Reply
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : null}

                      {replyTargetCommentId === comment.id ? (
                        <TaskCommentComposer
                          author={replyDraft.author}
                          authorDataRole="task-reply-author"
                          className="task-comment-reply-composer"
                          tasks={tasks}
                          agents={agents}
                          roles={roles}
                          interruptChecked={replyDraft.interruptAgent}
                          interruptDataRole="task-reply-interrupt"
                          message={replyDraft.message}
                          messageDataRole="task-reply-message"
                          messageRef={replyMessageRef}
                          messageLabel={`Reply to ${comment.author}`}
                          mentionListDataRole="task-reply-mention-list"
                          mentionOptionDataRole="task-reply-mention-option"
                          onAuthorChange={(author) => setReplyDraft({ ...replyDraft, author })}
                          onCancel={() => {
                            setReplyTargetCommentId(null);
                            setReplyDraft(createReplyDraft(commentDraft.author));
                            setPendingReplyFocusTargetId(null);
                          }}
                          onInterruptChange={(interruptAgent) => setReplyDraft({ ...replyDraft, interruptAgent })}
                          onMessageChange={(message) => setReplyDraft({ ...replyDraft, message })}
                          onSubmit={() => void handleAddReply()}
                          rows={3}
                          submitDataRole="add-task-reply"
                          submitLabel="Add reply"
                          cancelDataRole="cancel-task-reply"
                          cancelLabel="Cancel"
                          taskId={task.id}
                        />
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : <p className="muted-copy">No comments yet. Add one to capture guidance, review notes, or an interrupt request.</p>}
            </section>
          </div>
        )}
      </section>

      <section className="panel task-detail-tabs-panel">
        <div className="task-detail-tabs__body" ref={tabBodyRef}>{renderTabPanel()}</div>
      </section>

      {!isEditing && compactHeaderEligible && stickyChromeStyle ? (
        <div
          className={`task-detail-floating-header${compactHeaderShown ? "" : " task-detail-floating-header--hidden"}`}
          data-role="task-detail-compact-header"
          data-scroll-state={compactHeaderShown ? "visible" : "hidden"}
          style={{ ...stickyChromeStyle, top: `${floatingChromeLayout?.top ?? 0}px` }}
        >
          <div className="task-detail-floating-header__copy">
            <div className="task-detail-floating-header__title-row">
              <span className="status-badge status-badge--neutral">{task.number}</span>
              <h3>{taskHeading}</h3>
            </div>
            <div className="task-detail-floating-header__meta">
              <span className={`status-badge status-badge--${getStatusTone(task.status)}`}>{formatStatusLabel(task.status)}</span>
              {task.activeLaneAssignment ? (
                <span className={`status-badge status-badge--${task.activeLaneAssignment.status === "active" ? "success" : task.activeLaneAssignment.status === "queued" ? "warning" : "neutral"}`}>
                  {formatStatusLabel(task.activeLaneAssignment.status)}
                </span>
              ) : null}
            </div>
          </div>
          {renderHeaderActions(true)}
        </div>
      ) : null}

      {isEditing ? (
        <div className="task-detail-edit-fab" data-role="task-detail-edit-fab" aria-label="Task edit actions">
          <button
            className="secondary-button task-detail-edit-fab__button"
            data-role="cancel-task-edit"
            type="button"
            disabled={saving || publishing || Boolean(pendingActionId)}
            onClick={handleCancelEdit}
          >
            Cancel
          </button>
          <button
            className={`primary-button task-detail-edit-fab__button${saving || pendingActionId === "save" ? " task-action-button--pending" : ""}`}
            data-role="save-task"
            type="button"
            disabled={saving || publishing || loading || Boolean(pendingActionId) || !draft.title.trim()}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}

      {stickyChromeStyle ? (
        <div
          className={`task-detail-tab-dock${tabDockShown ? "" : " task-detail-tab-dock--hidden"}`}
          data-role="task-detail-tab-dock"
          data-scroll-state={tabDockShown ? "visible" : "hidden"}
          ref={tabDockRef}
          style={stickyChromeStyle}
        >
          <label className="task-detail-section-select" data-role="task-detail-section-select-mobile">
            <span className="task-detail-section-select__label">Section</span>
            <select
              className="select-input task-detail-section-select__control"
              data-role="task-detail-section-select-control"
              aria-label="Task detail section"
              value={activeNavItem}
              onChange={(event) => {
                const nextItem = event.target.value as TaskDetailNavItem;
                if (nextItem === "details") {
                  handleScrollToTaskDetails();
                  return;
                }
                if (nextItem === "comments") {
                  handleScrollToTaskComments();
                  return;
                }
                handleTabSelect(nextItem);
              }}
            >
              {NAV_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <div className="task-detail-tabs task-detail-tabs--dock" role="tablist" aria-label="Task detail panels">
            {NAV_OPTIONS.map((item) => {
              if (item.id === "details" || item.id === "comments") {
                return (
                  <button
                    key={item.id}
                    className={activeNavItem === item.id ? "task-detail-tab task-detail-tab--active" : "task-detail-tab task-detail-tab--jump"}
                    data-role={item.id === "details" ? "task-detail-tab-summary" : "task-detail-tab-comments"}
                    type="button"
                    onClick={item.id === "details" ? handleScrollToTaskDetails : handleScrollToTaskComments}
                  >
                    {item.label}
                  </button>
                );
              }

              const tabId = item.id as TaskDetailTab;

              return (
                <button
                  key={tabId}
                  className={activeNavItem === tabId ? "task-detail-tab task-detail-tab--active" : "task-detail-tab"}
                  data-role={`task-detail-tab-${tabId}`}
                  role="tab"
                  aria-selected={activeNavItem === tabId}
                  type="button"
                  onClick={() => handleTabSelect(tabId)}
                >
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      </div>

      {relaneConfirmTarget ? (
        <div className="quick-chat-overlay" data-role="task-relane-confirm-overlay" onClick={() => !pendingActionId && setRelaneConfirmTarget(null)}>
          <section className="quick-chat-modal panel task-delete-confirm" data-role="task-relane-confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Re-lane task</p>
                <h3>Move {task.number} to {relaneConfirmTarget.name}?</h3>
              </div>
            </div>
            <p>
              Orchestra will move this task into <strong>{relaneConfirmTarget.name}</strong>
              {task.activeLaneAssignment ? " and close the current lane assignment" : ""}.
              {effectiveActiveLaneAssignmentStatus === "awaiting_user_approval"
                ? " If you want to keep working in the current lane and reuse the same session, use Needs work instead."
                : effectiveActiveLaneAssignmentStatus === "awaiting_user_intervention"
                  ? " If you want to keep working in the current lane and reuse the same session, use Resume instead."
                  : " Worker-owned lanes will auto-dispatch after the move."}
            </p>
            <label className="field-group">
              <span className="field-group__label">Notes</span>
              <textarea
                className="text-area"
                data-role="task-relane-notes"
                rows={3}
                value={relaneNotes}
                onChange={(event) => setRelaneNotes(event.target.value)}
                placeholder="Explain why this task needs to move lanes"
              />
            </label>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" disabled={Boolean(pendingActionId)} onClick={() => setRelaneConfirmTarget(null)}>
                Cancel
              </button>
              <button className="primary-button" data-role="task-relane-confirm" type="button" disabled={Boolean(pendingActionId)} onClick={handleRelaneSubmit}>
                Move to lane
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showCloseConfirm ? (
        <div className="quick-chat-overlay" data-role="task-close-confirm-overlay" onClick={() => !closing && setShowCloseConfirm(false)}>
          <section className="quick-chat-modal panel task-delete-confirm" data-role="task-close-confirm" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Close task</p>
                <h3>Close {task.number}?</h3>
              </div>
            </div>
            <p>This keeps the task and its history, but marks it as canceled so it is closed immediately.</p>
            <label className="field-group">
              <span className="field-group__label">Reason (optional)</span>
              <textarea
                className="text-area"
                data-role="task-close-reason"
                rows={3}
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
                placeholder="Why are you canceling this task?"
              />
            </label>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" disabled={closing} onClick={() => setShowCloseConfirm(false)}>
                Cancel
              </button>
              <button className="primary-button" data-role="confirm-close-task" type="button" disabled={closing} onClick={() => onClose(closeReason.trim() || undefined)}>
                {closing ? "Closing…" : "Close task"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

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
