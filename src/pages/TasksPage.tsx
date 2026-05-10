import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { TaskActionMenuAction } from "../components/TaskActionMenu";
import { ResourceStatusBanner } from "../components/ResourceStatusBanner";
import { retryOrchestraRead, useOrchestraClient } from "../lib/orchestraClient";
import { useOrchestraConnection } from "../lib/orchestraData/connection";
import { reportUiError, toUiErrorState, type UiErrorState } from "../lib/orchestraData/errors";
import { useTaskAutoRefresh } from "../lib/orchestraData/tasks";
import { formatTaskCommentAnchorLabel } from "../lib/taskComments";
import { applyTaskListQuery } from "../lib/taskListQuery";
import { getTaskOpenSessionTarget } from "../lib/taskOpenSession";
import { hasTaskDetailOverviewHistoryEntry } from "../lib/taskHistory";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type {
  AgentSummary,
  MailboxMessage,
  RepositoryRecord,
  RoleSummary,
  SessionRecord,
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
import { SessionReferenceLink, buildEntityReferenceLookup } from "../components/entity-links";
import { TaskCreatePage } from "./tasks/TaskCreatePage";
import { TaskDetailPage } from "./tasks/TaskDetailPage";
import { TaskScheduleDetailPage } from "./tasks/TaskScheduleDetailPage";
import { getEffectiveTaskDetailAssignmentStatus } from "./tasks/taskDetailActionState";
import { buildTaskDetailHeaderActions } from "./tasks/taskDetailHeaderActions";
import { getTaskDetailRenderState, shouldApplyTaskDetailLoad, shouldApplyTaskScheduleLoad, type TaskDetailRouteState } from "./tasks/taskDetailLoadGuards";
import { buildTaskBoardModel, getVisibleTaskBoardTags, isDraftTask, type TaskBoardModel } from "./tasks/taskBoardModel";
import { TasksOverviewPage } from "./tasks/TasksOverviewPage";
import { DEFAULT_TASK_OVERVIEW_STATE, type TaskOverviewState } from "./tasks/taskOverviewState";
import { buildTaskDependencyTree, collectTaskDependencyTreeNeighborIds, type TaskDependencyTreeNode } from "./tasks/taskDependencyTree";
import { formatTaskAttachmentSize } from "../lib/taskAttachments";

type TasksRoute =
  | { kind: "overview" }
  | { kind: "create"; parentTaskId?: string | null; workflowId?: string | null; scheduled?: boolean }
  | { kind: "detail"; taskId: string }
  | { kind: "schedule"; scheduleId: string };

type OverviewScrollTarget =
  | { kind: "element"; element: HTMLElement }
  | { kind: "window" };

type OverviewScrollElementSignature = {
  tagName: string;
  className: string;
  dataRole: string | null;
  index: number;
};

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

function isVerticallyScrollable(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && element.scrollHeight > element.clientHeight;
}

function findNearestScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    if (isVerticallyScrollable(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function buildElementPath(root: HTMLElement | null, target: HTMLElement): number[] | null {
  if (!root || !root.contains(target)) {
    return null;
  }
  const path: number[] = [];
  let current: HTMLElement | null = target;
  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      return null;
    }
    const childIndex = Array.prototype.indexOf.call(parent.children, current) as number;
    if (childIndex < 0) {
      return null;
    }
    path.unshift(childIndex);
    current = parent;
  }
  return current === root ? path : null;
}

function resolveElementPath(root: HTMLElement | null, path: number[] | null): HTMLElement | null {
  if (!root || !path) {
    return null;
  }
  let current: Element = root;
  for (const childIndex of path) {
    const next = current.children.item(childIndex);
    if (!(next instanceof HTMLElement)) {
      return null;
    }
    current = next;
  }
  return current instanceof HTMLElement ? current : null;
}

function buildOverviewScrollElementSignature(
  root: HTMLElement | null,
  target: HTMLElement,
): OverviewScrollElementSignature | null {
  if (!root || !root.contains(target)) {
    return null;
  }
  const tagName = target.tagName;
  const className = target.className;
  const dataRole = target.getAttribute("data-role");
  const matches = Array.from(root.querySelectorAll<HTMLElement>(tagName)).filter(
    (element) =>
      element.className === className &&
      element.getAttribute("data-role") === dataRole,
  );
  const index = matches.indexOf(target);
  if (index < 0) {
    return null;
  }
  return { tagName, className, dataRole, index };
}

function resolveOverviewScrollElementSignature(
  root: HTMLElement | null,
  signature: OverviewScrollElementSignature | null,
): HTMLElement | null {
  if (!root || !signature) {
    return null;
  }
  const matches = Array.from(root.querySelectorAll<HTMLElement>(signature.tagName)).filter(
    (element) =>
      element.className === signature.className &&
      element.getAttribute("data-role") === signature.dataRole,
  );
  return matches[signature.index] ?? null;
}

function findOverviewTaskElement(
  root: HTMLElement | null,
  taskId: string | null,
): HTMLElement | null {
  if (!root || !taskId) {
    return null;
  }
  return root.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
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
    tags: [],
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
    tags: task.tags ?? [],
  };
}

interface TaskTimelineItem {
  id: string;
  kind: "comment" | "attachment" | "file_reference" | "lane_run" | "domain_event" | "dependency_in" | "dependency_out";
  title: string;
  description: ReactNode;
  timestamp: string;
  tone: "neutral" | "warning" | "success" | "error";
}

export type TasksMobileHeaderAction = Omit<TaskActionMenuAction, "onClick">;

export interface TasksMobileHeaderContext {
  signature: string;
  title: string;
  backLabel: string;
  onBack: () => void;
  actionMenuLabel?: string;
  actions?: TasksMobileHeaderAction[];
  onAction?: (actionId: string) => void;
}

interface TasksPageProps {
  projectId?: string | null;
  createTaskToken?: number;
  createTaskProjectId?: string | null;
  openTaskRequest?: { taskId: string; token: number; projectId: string | null } | null;
  taskOverviewState?: TaskOverviewState;
  tasksOverviewToken?: number;
  onTaskOverviewStateChange?: (nextState: TaskOverviewState | ((current: TaskOverviewState) => TaskOverviewState)) => void;
  onSelectedTaskIdChange?: (taskId: string | null) => void;
  onOpenTaskTag?: (tag: string) => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenRole?: (roleId: string) => void;
  onOpenSession?: (sessionId: string, projectId?: string | null) => void;
  onOpenTaskSession?: (sessionId: string, projectId?: string | null) => void;
  referenceSessions?: SessionRecord[];
  onMobileHeaderContextChange?: (context: TasksMobileHeaderContext | null) => void;
  showCreateFab?: boolean;
}

function sameData<T>(current: T, next: T) {
  return JSON.stringify(current) === JSON.stringify(next);
}

function stripMobileHeaderActionData(actions: TaskActionMenuAction[]): TasksMobileHeaderAction[] {
  return actions.map(({ onClick: _onClick, dataRole: _dataRole, ...action }) => action);
}

export function TasksPage({
  projectId = null,
  createTaskToken = 0,
  createTaskProjectId = null,
  openTaskRequest = null,
  taskOverviewState = DEFAULT_TASK_OVERVIEW_STATE,
  tasksOverviewToken = 0,
  onTaskOverviewStateChange,
  onSelectedTaskIdChange,
  onOpenTaskTag,
  onOpenAgent,
  onOpenRole,
  onOpenSession,
  onOpenTaskSession,
  referenceSessions = [],
  onMobileHeaderContextChange,
  showCreateFab = true,
}: TasksPageProps) {
  const orchestraClient = useOrchestraClient();
  const connection = useOrchestraConnection();
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
  const [taskActionError, setTaskActionError] = useState<UiErrorState | null>(null);
  const [showDeleteCommentConfirm, setShowDeleteCommentConfirm] = useState(false);
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null);
  const [deleteCommentImpact, setDeleteCommentImpact] = useState<import("../types").TaskCommentDeleteImpact | null>(null);
  const [loadingDeleteCommentImpact, setLoadingDeleteCommentImpact] = useState(false);
  const [deletingComment, setDeletingComment] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [refreshingTasks, setRefreshingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [publishingTask, setPublishingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [closingTask, setClosingTask] = useState(false);
  const [sendingTaskMail, setSendingTaskMail] = useState(false);
  const [detailActionPending, setDetailActionPending] = useState<string | null>(null);
  const [mobileCompletionOutcome, setMobileCompletionOutcome] = useState<"success" | "failure" | null>(null);
  const [mobileCompletionSummary, setMobileCompletionSummary] = useState("");
  const [mobileCompletionNotes, setMobileCompletionNotes] = useState("");
  const [selectedBlockerTaskId, setSelectedBlockerTaskId] = useState("");
  const [dependencyViewMode, setDependencyViewMode] = useState<"list" | "tree">("list");
  const [dependencyTreeTasksById, setDependencyTreeTasksById] = useState<Record<string, TaskDetail>>({});
  const [loadingDependencyTree, setLoadingDependencyTree] = useState(false);
  const [taskDetailEditing, setTaskDetailEditing] = useState(false);
  const [taskScheduleEditing, setTaskScheduleEditing] = useState(false);
  const createTaskTokenRef = useRef(0);
  const openTaskTokenRef = useRef(0);
  const tasksOverviewTokenRef = useRef(0);
  const lastProjectIdRef = useRef<string | null>(projectId);
  const pageRootRef = useRef<HTMLElement | null>(null);
  const lastOverviewScrollRootRef = useRef<HTMLElement | null>(null);
  const savedOverviewScrollTopRef = useRef(0);
  const savedOverviewTaskIdRef = useRef<string | null>(null);
  const savedOverviewTaskViewportTopRef = useRef<number | null>(null);
  const savedOverviewScrollElementPathRef = useRef<number[] | null>(null);
  const savedOverviewScrollElementSignatureRef = useRef<OverviewScrollElementSignature | null>(null);
  const savedOverviewScrollTargetKindRef = useRef<OverviewScrollTarget["kind"]>("element");
  const shouldRestoreOverviewScrollRef = useRef(false);
  const previousRouteKindRef = useRef<TasksRoute["kind"]>("overview");
  const routeRef = useRef<TaskDetailRouteState>({ kind: "overview" });
  const taskDetailLoadRequestRef = useRef(0);
  const taskDependencyTreeLoadRequestRef = useRef(0);
  const taskScheduleLoadRequestRef = useRef(0);
  const getTooltipProps = useExplanatoryTooltipProps();

  const noopOpenTaskTag = useCallback((_tag: string) => {}, []);
  const noopOpenSession = useCallback((_sessionId: string, _projectId?: string | null) => {}, []);
  const noopOpenAgent = useCallback((_agentId: string) => {}, []);
  const noopOpenRole = useCallback((_roleId: string) => {}, []);

  const openTaskTagHandler = onOpenTaskTag ?? noopOpenTaskTag;
  const openSessionHandler = onOpenSession ?? noopOpenSession;
  const openTaskSessionHandler = onOpenTaskSession ?? onOpenSession ?? noopOpenSession;
  const openAgentHandler = onOpenAgent ?? noopOpenAgent;
  const openRoleHandler = onOpenRole ?? noopOpenRole;

  const getOverviewScrollTarget = useCallback((): OverviewScrollTarget | null => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return null;
    }

    const scrollRoot =
      findNearestScrollableAncestor(pageRootRef.current) ??
      document.querySelector<HTMLElement>(".content") ??
      lastOverviewScrollRootRef.current;
    const windowScrollTop = Math.max(
      window.scrollY,
      document.documentElement.scrollTop,
      document.body.scrollTop,
    );
    if (scrollRoot && scrollRoot.scrollHeight > scrollRoot.clientHeight) {
      if (scrollRoot.scrollTop > 0 || windowScrollTop === 0) {
        lastOverviewScrollRootRef.current = scrollRoot;
        return { kind: "element", element: scrollRoot };
      }
    }

    if (
      windowScrollTop > 0 ||
      document.documentElement.scrollHeight > window.innerHeight ||
      document.body.scrollHeight > window.innerHeight
    ) {
      return { kind: "window" };
    }

    if (scrollRoot) {
      lastOverviewScrollRootRef.current = scrollRoot;
      return { kind: "element", element: scrollRoot };
    }

    return null;
  }, []);

  const captureOverviewScrollPosition = useCallback((taskId?: string | null) => {
    const scrollTarget = getOverviewScrollTarget();
    if (!scrollTarget) {
      return;
    }

    savedOverviewScrollTopRef.current =
      scrollTarget.kind === "window"
        ? Math.max(
            window.scrollY,
            document.documentElement.scrollTop,
            document.body.scrollTop,
          )
        : scrollTarget.element.scrollTop;
    savedOverviewScrollElementPathRef.current =
      scrollTarget.kind === "element"
        ? buildElementPath(pageRootRef.current, scrollTarget.element)
        : null;
    savedOverviewScrollElementSignatureRef.current =
      scrollTarget.kind === "element"
        ? buildOverviewScrollElementSignature(
            pageRootRef.current,
            scrollTarget.element,
          )
        : null;
    savedOverviewTaskIdRef.current = taskId ?? null;
    savedOverviewTaskViewportTopRef.current =
      taskId && pageRootRef.current
        ? findOverviewTaskElement(pageRootRef.current, taskId)?.getBoundingClientRect()
            .top ?? null
        : null;
    savedOverviewScrollTargetKindRef.current = scrollTarget.kind;
    shouldRestoreOverviewScrollRef.current = true;
  }, [getOverviewScrollTarget]);

  const returnToOverviewFromTaskDetail = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      hasTaskDetailOverviewHistoryEntry(window.history.state)
    ) {
      window.history.back();
      return;
    }
    setRoute({ kind: "overview" });
  }, []);

  const tagScopedTasks = useMemo(
    () => applyTaskListQuery(tasks, { tags: taskOverviewState.tags, tagMatch: taskOverviewState.tagMatch, sort: taskOverviewState.sort }),
    [taskOverviewState.sort, taskOverviewState.tagMatch, taskOverviewState.tags, tasks],
  );

  const filteredTasks = useMemo(() => {
    switch (taskOverviewState.boardFilter) {
      case "attention":
        return tagScopedTasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked);
      case "review":
        return tagScopedTasks.filter((task) => task.status === "in_review");
      case "blocked":
        return tagScopedTasks.filter((task) => task.status === "blocked" || task.dependencyBlocked);
      case "active":
        return tagScopedTasks.filter((task) => task.status === "in_progress" || task.readyForDispatch);
      case "done":
        return tagScopedTasks.filter((task) => task.status === "completed" || task.status === "canceled");
      case "epics":
        return tagScopedTasks.filter((task) => task.type === "epic");
      default:
        return tagScopedTasks;
    }
  }, [tagScopedTasks, taskOverviewState.boardFilter]);

  const boardModel: TaskBoardModel = useMemo(() => buildTaskBoardModel(filteredTasks, workflowDefinitions), [filteredTasks, workflowDefinitions]);

  const availableTags = useMemo(
    () => getVisibleTaskBoardTags(boardModel, taskOverviewState.boardFilter === "done"),
    [boardModel, taskOverviewState.boardFilter],
  );
  const entityLookup = useMemo(
    () => buildEntityReferenceLookup({ tasks, sessions: referenceSessions, agents, roles }),
    [agents, referenceSessions, roles, tasks],
  );

  const attentionTasks = useMemo(
    () => tagScopedTasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked),
    [tagScopedTasks],
  );

  const runDetailAction = useCallback(async (actionId: string, operation: () => Promise<void>, fallbackMessage: string) => {
    setTaskActionError(null);
    setDetailActionPending(actionId);
    try {
      await operation();
    } catch (error) {
      setTaskActionError(await reportUiError(orchestraClient, `ui.tasks.detail_action.${actionId}`, error, fallbackMessage));
    } finally {
      setDetailActionPending(null);
    }
  }, [orchestraClient]);

  const timelineItems = useMemo<TaskTimelineItem[]>(() => {
    if (!taskDetail) {
      return [];
    }

    const comments = taskDetail.comments.map<TaskTimelineItem>((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment",
      title: comment.parentCommentId ? `${comment.author} replied` : `${comment.author} commented`,
      description: [
        formatTaskCommentAnchorLabel(comment),
        comment.message,
      ].filter(Boolean).join("\n\n"),
      timestamp: comment.updatedAt,
      tone: comment.interruptAgent ? "warning" : "neutral",
    }));

    const attachments = taskDetail.attachments.map<TaskTimelineItem>((attachment) => ({
      id: `attachment-${attachment.id}`,
      kind: "attachment",
      title: `Attachment added: ${attachment.fileName}`,
      description: `${attachment.mediaType} · ${formatTaskAttachmentSize(attachment.byteSize)}`,
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
      description: (
        <span>
          {laneRun.result.replace(/_/g, " ")} · {" "}
          <SessionReferenceLink
            lookup={entityLookup.sessions}
            onOpenSession={onOpenSession ?? null}
            projectId={taskDetail.projectId}
            rawIdMode="secondary"
            sessionId={laneRun.sessionId}
            sessionTitle={laneRun.sessionTitle ?? null}
          />
        </span>
      ),
      timestamp: laneRun.completedAt ?? laneRun.startedAt,
      tone: laneRun.result === "success" ? "success" : laneRun.result === "failure" ? "error" : "neutral",
    }));

    const domainEvents = (taskDetail.domainEvents ?? []).map<TaskTimelineItem>((event) => {
      const payload = typeof event.payload === "object" && event.payload && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const whipCount = typeof payload.whipCount === "number" ? payload.whipCount : null;
      const unansweredWhipCount = typeof payload.unansweredWhipCount === "number" ? payload.unansweredWhipCount : null;
      const note = typeof payload.note === "string" ? payload.note : null;

      if (event.topic === "task.whip.reset") {
        return {
          id: `domain-event-${event.id}`,
          kind: "domain_event",
          title: "Session reset after unanswered whips",
          description: [
            unansweredWhipCount === null ? null : `Unanswered whips: ${unansweredWhipCount}`,
            note,
          ].filter(Boolean).join(" · "),
          timestamp: event.createdAt,
          tone: "warning",
        };
      }
      if (event.topic === "task.whip.escalated") {
        return {
          id: `domain-event-${event.id}`,
          kind: "domain_event",
          title: "Whip limit escalated to user intervention",
          description: whipCount === null ? "Automatic intervention requested." : `Whips sent: ${whipCount}`,
          timestamp: event.createdAt,
          tone: "error",
        };
      }
      return {
        id: `domain-event-${event.id}`,
        kind: "domain_event",
        title: "Automatic whip sent",
        description: [
          whipCount === null ? null : `Whip ${whipCount}`,
          unansweredWhipCount === null ? null : `unanswered ${unansweredWhipCount}`,
        ].filter(Boolean).join(" · "),
        timestamp: event.createdAt,
        tone: "neutral",
      };
    });

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

    return [...comments, ...attachments, ...fileReferences, ...laneRuns, ...domainEvents, ...blockedBy, ...blocking].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
    );
  }, [entityLookup.sessions, onOpenSession, taskDetail]);

  const dependencyTree = useMemo<TaskDependencyTreeNode | null>(() => {
    if (!taskDetail) {
      return null;
    }

    return buildTaskDependencyTree(taskDetail.id, {
      ...dependencyTreeTasksById,
      [taskDetail.id]: taskDetail,
    });
  }, [dependencyTreeTasksById, taskDetail]);

  const dependencyCandidates = useMemo(
    () => tasks.filter((task) => route.kind === "detail" && task.id !== route.taskId),
    [route, tasks],
  );

  const taskWorkflowLanes = useMemo(
    () => (taskDetail?.workflowId ? (workflowDefinitions[taskDetail.workflowId]?.lanes ?? []).map((lane) => ({ id: lane.id, name: lane.name })) : []),
    [taskDetail?.workflowId, workflowDefinitions],
  );
  const taskDetailRenderState = useMemo(
    () => getTaskDetailRenderState(route, taskDetail?.id ?? null, loadingTaskDetail),
    [route, taskDetail?.id, loadingTaskDetail],
  );

  const loadTasksData = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoadingTasks(true);
    } else {
      setRefreshingTasks(true);
    }
    setTaskActionError(null);
    try {
      const [nextTasks, nextSchedules, nextWorkflows, nextAgents, nextRoles, nextProject] = await retryOrchestraRead(() => Promise.all([
        orchestraClient.tasks.list({ includeArchived: false, projectId }),
        orchestraClient.tasks.listSchedules(projectId),
        orchestraClient.catalog.listWorkflows(false),
        orchestraClient.catalog.listAgents(false, projectId),
        orchestraClient.catalog.listRoles(false),
        projectId ? orchestraClient.catalog.getProject(projectId) : Promise.resolve(null),
      ]));
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
      const definitions = await retryOrchestraRead(() => Promise.all(workflowIds.map((workflowId) => orchestraClient.catalog.getWorkflow(workflowId))));
      const nextDefinitions = Object.fromEntries(definitions.map((definition) => [definition.id, definition]));
      setWorkflowDefinitions((current) => (sameData(current, nextDefinitions) ? current : nextDefinitions));
    } catch (error) {
      setTaskActionError(await reportUiError(orchestraClient, "ui.tasks.load", error, "Unable to load tasks."));
    } finally {
      setLoadingTasks(false);
      setRefreshingTasks(false);
    }
  }, [orchestraClient, projectId]);

  const loadTaskDetail = useCallback(async (taskId: string, options?: { preserveDraft?: boolean; silent?: boolean }) => {
    const requestId = ++taskDetailLoadRequestRef.current;
    if (!options?.silent) {
      setLoadingTaskDetail(true);
      setTaskActionError(null);
    }
    try {
      const [task, messages] = await retryOrchestraRead(() => Promise.all([orchestraClient.tasks.get(taskId), orchestraClient.tasks.listMessages(taskId)]));
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
        setTaskActionError(await reportUiError(orchestraClient, "ui.tasks.detail.load", error, "Unable to load task."));
      }
    } finally {
      if (!options?.silent && taskDetailLoadRequestRef.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }, [orchestraClient, repositories]);

  const loadTaskDependencyTree = useCallback(async (rootTask: TaskDetail) => {
    const requestId = ++taskDependencyTreeLoadRequestRef.current;
    setLoadingDependencyTree(true);
    try {
      const loadedTasksById: Record<string, TaskDetail> = { [rootTask.id]: rootTask };
      let pendingTaskIds = collectTaskDependencyTreeNeighborIds(rootTask).filter((taskId) => !loadedTasksById[taskId]);

      while (pendingTaskIds.length) {
        const loadedTasks = await retryOrchestraRead(() => Promise.all(pendingTaskIds.map((taskId) => orchestraClient.tasks.get(taskId))));
        if (routeRef.current.kind !== "detail" || routeRef.current.taskId !== rootTask.id || taskDependencyTreeLoadRequestRef.current !== requestId) {
          return;
        }

        for (const task of loadedTasks) {
          loadedTasksById[task.id] = task;
        }

        pendingTaskIds = Array.from(new Set(loadedTasks.flatMap(collectTaskDependencyTreeNeighborIds))).filter((taskId) => !loadedTasksById[taskId]);
      }

      if (routeRef.current.kind === "detail" && routeRef.current.taskId === rootTask.id && taskDependencyTreeLoadRequestRef.current === requestId) {
        setDependencyTreeTasksById((current) => (sameData(current, loadedTasksById) ? current : loadedTasksById));
      }
    } catch (error) {
      if (taskDependencyTreeLoadRequestRef.current === requestId) {
        setTaskActionError(await reportUiError(orchestraClient, "ui.tasks.dependency_tree.load", error, "Unable to load dependency tree."));
      }
    } finally {
      if (taskDependencyTreeLoadRequestRef.current === requestId) {
        setLoadingDependencyTree(false);
      }
    }
  }, [orchestraClient]);

  const loadTaskScheduleDetail = useCallback(async (scheduleId: string, options?: { preserveDraft?: boolean; silent?: boolean }) => {
    const requestId = ++taskScheduleLoadRequestRef.current;
    if (!options?.silent) {
      setLoadingTaskDetail(true);
      setTaskActionError(null);
    }
    try {
      const schedule = await retryOrchestraRead(() => orchestraClient.tasks.getSchedule(scheduleId));
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
        setTaskActionError(await reportUiError(orchestraClient, "ui.tasks.schedule.load", error, "Unable to load task schedule."));
      }
    } finally {
      if (!options?.silent && taskScheduleLoadRequestRef.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }, [orchestraClient]);

  useEffect(() => {
    void loadTasksData();
  }, [projectId]);

  useEffect(() => {
    routeRef.current = toTaskDetailRouteState(route);
  }, [route]);

  useEffect(() => {
    const previousRouteKind = previousRouteKindRef.current;
    if (previousRouteKind === "detail" && route.kind === "overview" && shouldRestoreOverviewScrollRef.current) {
      const savedScrollTop = savedOverviewScrollTopRef.current;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          let restoreAttempts = 0;
          const restoreScroll = () => {
            if (savedOverviewScrollTargetKindRef.current === "window") {
              window.scrollTo({ top: savedScrollTop, behavior: "auto" });
              window.dispatchEvent(new Event("scroll"));
              shouldRestoreOverviewScrollRef.current = false;
              return;
            }

            const scrollTarget = getOverviewScrollTarget();
            const scrollRoot =
              resolveElementPath(
                pageRootRef.current,
                savedOverviewScrollElementPathRef.current,
              ) ??
              resolveOverviewScrollElementSignature(
                pageRootRef.current,
                savedOverviewScrollElementSignatureRef.current,
              ) ??
              (scrollTarget?.kind === "element"
                ? scrollTarget.element
                : lastOverviewScrollRootRef.current);
            if (!scrollRoot) {
              return;
            }
            scrollRoot.scrollTop = savedScrollTop;
            const savedTaskTop = savedOverviewTaskViewportTopRef.current;
            const savedTaskElement = findOverviewTaskElement(
              pageRootRef.current,
              savedOverviewTaskIdRef.current,
            );
            if (savedTaskElement) {
              savedTaskElement.scrollIntoView({ block: "nearest", inline: "nearest" });
              if (savedTaskTop !== null) {
                const taskScrollRoot =
                  findNearestScrollableAncestor(savedTaskElement) ?? scrollRoot;
                taskScrollRoot.scrollTop +=
                  savedTaskElement.getBoundingClientRect().top - savedTaskTop;
              }
            }
            scrollRoot.dispatchEvent(new Event("scroll"));
            restoreAttempts += 1;
            if (Math.abs(scrollRoot.scrollTop - savedScrollTop) > 1 && restoreAttempts < 5) {
              requestAnimationFrame(restoreScroll);
              return;
            }
            shouldRestoreOverviewScrollRef.current = false;
          };
          restoreScroll();
        });
      });
    }
    previousRouteKindRef.current = route.kind;
  }, [getOverviewScrollTarget, route.kind]);

  useEffect(() => {
    taskDependencyTreeLoadRequestRef.current += 1;
    setDependencyViewMode("list");
    setDependencyTreeTasksById({});
    setLoadingDependencyTree(false);
  }, [route.kind === "detail" ? route.taskId : null]);

  useEffect(() => {
    if (route.kind === "detail") {
      void loadTaskDetail(route.taskId, { preserveDraft: taskDraftDirty });
    }
    if (route.kind === "schedule") {
      void loadTaskScheduleDetail(route.scheduleId, { preserveDraft: taskScheduleDraftDirty });
    }
  }, [route.kind === "detail" ? route.taskId : null, route.kind === "schedule" ? route.scheduleId : null]);

  useEffect(() => {
    if (route.kind !== "detail") {
      setTaskDetailEditing(false);
    }
    if (route.kind !== "schedule") {
      setTaskScheduleEditing(false);
    }
  }, [route]);

  useEffect(() => {
    if (route.kind !== "detail" || dependencyViewMode !== "tree" || !taskDetail || taskDetail.id !== route.taskId) {
      return;
    }

    void loadTaskDependencyTree(taskDetail);
  }, [dependencyViewMode, loadTaskDependencyTree, route, taskDetail]);

  useEffect(() => {
    onSelectedTaskIdChange?.(route.kind === "detail" ? route.taskId : null);
  }, [onSelectedTaskIdChange, route]);

  useTaskAutoRefresh({
    disabled: route.kind === "create",
    selectedTaskId: route.kind === "detail" ? route.taskId : null,
    selectedScheduleId: route.kind === "schedule" ? route.scheduleId : null,
    canRefreshSelectedTask: route.kind === "detail" && !taskDraftDirty,
    canRefreshSelectedSchedule: route.kind === "schedule" && !taskScheduleDraftDirty,
    refreshTasks: () => {
      void loadTasksData({ silent: true });
    },
    refreshTaskDetail: (taskId) => {
      void loadTaskDetail(taskId, { silent: true });
    },
    refreshTaskSchedule: (scheduleId) => {
      void loadTaskScheduleDetail(scheduleId, { silent: true });
    },
  });

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

  function updateTaskOverviewState(nextState: TaskOverviewState | ((current: TaskOverviewState) => TaskOverviewState)) {
    onTaskOverviewStateChange?.(nextState);
  }

  const openTaskDetail = useCallback((taskId: string) => {
    if (routeRef.current.kind === "overview") {
      captureOverviewScrollPosition(taskId);
    }
    taskDetailLoadRequestRef.current += 1;
    setTaskScheduleDetail(null);
    setRoute({ kind: "detail", taskId });
  }, [captureOverviewScrollPosition]);

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
    const latest = await orchestraClient.tasks.get(taskId);
    if (latest.readyForDispatch) {
      await orchestraClient.tasks.dispatch(taskId);
    }
  }

  async function handleSaveCreateTask() {
    setSavingTask(true);
    setTaskActionError(null);
    try {
      if (creatingScheduledTask) {
        const saved = await orchestraClient.tasks.createSchedule({ ...taskScheduleDraft, enabled: false }, projectId);
        await loadTasksData();
        setRoute({ kind: "schedule", scheduleId: saved.id });
        await loadTaskScheduleDetail(saved.id);
        setTaskScheduleDraftDirty(false);
      } else {
        const saved = await orchestraClient.tasks.create({ ...taskDraft, status: "draft" }, projectId);
        await loadTasksData();
        setRoute({ kind: "detail", taskId: saved.id });
        await loadTaskDetail(saved.id);
        setTaskDraftDirty(false);
        setSelectedBlockerTaskId("");
      }
    } catch (error) {
      setTaskActionError(
        await reportUiError(
          orchestraClient,
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
        const saved = await orchestraClient.tasks.createSchedule({ ...taskScheduleDraft, enabled: true }, projectId);
        await loadTasksData();
        setRoute({ kind: "schedule", scheduleId: saved.id });
        await loadTaskScheduleDetail(saved.id);
        setTaskScheduleDraftDirty(false);
      } else {
        const saved = await orchestraClient.tasks.create({ ...taskDraft, status: "ready" }, projectId);
        await maybeDispatchPublishedTask(saved.id);
        await loadTasksData();
        setRoute({ kind: "detail", taskId: saved.id });
        await loadTaskDetail(saved.id);
        setTaskDraftDirty(false);
        setSelectedBlockerTaskId("");
      }
    } catch (error) {
      setTaskActionError(
        await reportUiError(
          orchestraClient,
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
      const saved = await orchestraClient.tasks.update(route.taskId, taskDraft);
      await loadTasksData();
      await loadTaskDetail(saved.id);
      setTaskDraftDirty(false);
    }, "Unable to save task.");
    setSavingTask(false);
  }

  function handleCancelDetailEdit() {
    if (!taskDetail) {
      return;
    }
    setTaskDraft(taskToDraft(taskDetail));
    setTaskDraftDirty(false);
  }

  async function handleSaveTaskScheduleDetail() {
    if (route.kind !== "schedule") {
      return;
    }
    setSavingTask(true);
    await runDetailAction("save_schedule", async () => {
      const saved = await orchestraClient.tasks.updateSchedule(route.scheduleId, taskScheduleDraft);
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
      const saved = await orchestraClient.tasks.update(route.taskId, { ...taskDraft, status: "ready" });
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
      await orchestraClient.tasks.remove(route.taskId);
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
      let currentTask = taskDetail ?? await orchestraClient.tasks.get(route.taskId);
      const trimmedReason = reason?.trim();
      if (trimmedReason) {
        await orchestraClient.tasks.comment(route.taskId, {
          author: commentDraft.author || "User",
          message: `Task canceled: ${trimmedReason}`,
          interruptAgent: false,
        });
        currentTask = await orchestraClient.tasks.get(route.taskId);
      }
      if (currentTask.activeLaneAssignment) {
        await orchestraClient.tasks.stopActivity(route.taskId);
      }
      const saved = await orchestraClient.tasks.update(route.taskId, {
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
      await orchestraClient.tasks.deleteSchedule(route.scheduleId);
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
      await orchestraClient.tasks.addDependency(selectedBlockerTaskId, route.taskId);
      setSelectedBlockerTaskId("");
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to add dependency."));
    }
  }

  async function handleRemoveDependency(dependencyId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.removeDependency(dependencyId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to remove dependency."));
    }
  }

  async function handleAttachmentInputChange(files: FileList | null) {
    if (route.kind !== "detail" || !files?.length) {
      return;
    }
    setTaskActionError(null);
    try {
      for (const file of Array.from(files)) {
        await orchestraClient.tasks.addAttachment(route.taskId, {
          fileName: file.name,
          mediaType: file.type || "application/octet-stream",
          file,
          caption: null,
        });
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to add attachment."));
    }
  }

  async function handleDownloadAttachment(attachmentId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.downloadAttachment(attachmentId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to download attachment."));
    }
  }

  async function handleRemoveAttachment(attachmentId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.removeAttachment(attachmentId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to remove attachment."));
    }
  }

  async function handleAddFileReference() {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.addFileReference(route.taskId, fileReferenceDraft);
      setFileReferenceDraft({ repositoryId: fileReferenceDraft.repositoryId || (repositories[0]?.id ?? ""), relativePath: "" });
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to add file reference."));
    }
  }

  async function handleRemoveFileReference(referenceId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.removeFileReference(referenceId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to remove file reference."));
    }
  }

  async function handleSetDefaultFileReference(referenceId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.setDefaultFileReference(referenceId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to set default file reference."));
    }
  }

  async function handleAddTaskTodo(description: string, laneId: string) {
    if (route.kind !== "detail") {
      return;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.addTodo(route.taskId, { description, laneId });
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to add task todo."));
    }
  }

  async function handleMarkTaskTodoFinished(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-finished-${todoId}`, async () => {
      await orchestraClient.tasks.markTodoFinished(todoId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to mark task todo finished.");
  }

  async function handleMarkTaskTodoUnfinished(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-unfinished-${todoId}`, async () => {
      await orchestraClient.tasks.markTodoUnfinished(todoId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to mark task todo unfinished.");
  }

  async function handleDeleteTaskTodo(todoId: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction(`task-todo-delete-${todoId}`, async () => {
      await orchestraClient.tasks.deleteTodo(todoId);
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
      await orchestraClient.tasks.markCommentsRead(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to mark task comments read."));
    }
  }

  const handleAddComment = useCallback(async (draft: TaskCommentInput): Promise<boolean> => {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.comment(route.taskId, draft);
      if (!draft.parentCommentId) {
        setCommentDraft(createBlankCommentDraft());
      }
      await loadTasksData({ silent: true });
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
      return true;
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to add comment."));
      return false;
    }
  }, [loadTaskDetail, loadTasksData, orchestraClient.tasks, route.kind, route.kind === "detail" ? route.taskId : null]);

  const handleUpdateComment = useCallback(async (commentId: string, message: string): Promise<boolean> => {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.updateComment(commentId, { message });
      await loadTasksData({ silent: true });
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
      return true;
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to update comment."));
      return false;
    }
  }, [loadTaskDetail, loadTasksData, orchestraClient.tasks, route.kind, route.kind === "detail" ? route.taskId : null]);

  const handleDeleteComment = useCallback(async (commentId: string): Promise<boolean> => {
    if (route.kind !== "detail") {
      return false;
    }
    setTaskActionError(null);
    try {
      // Fetch delete impact first
      setLoadingDeleteCommentImpact(true);
      const impact = await orchestraClient.tasks.getCommentDeleteImpact(commentId);
      setDeleteCommentImpact(impact);
      setPendingDeleteCommentId(commentId);
      setShowDeleteCommentConfirm(true);
      return false; // Don't auto-delete; let the user confirm in the modal
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to load delete impact."));
      return false;
    } finally {
      setLoadingDeleteCommentImpact(false);
    }
  }, [orchestraClient.tasks, route.kind]);

  async function handleConfirmDeleteComment(): Promise<boolean> {
    const commentId = pendingDeleteCommentId;
    if (!commentId || route.kind !== "detail") {
      setShowDeleteCommentConfirm(false);
      return false;
    }
    setDeletingComment(true);
    setTaskActionError(null);
    try {
      await orchestraClient.tasks.deleteComment(commentId);
      await loadTasksData({ silent: true });
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
      setShowDeleteCommentConfirm(false);
      setPendingDeleteCommentId(null);
      setDeleteCommentImpact(null);
      return true;
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to delete comment."));
      return false;
    } finally {
      setDeletingComment(false);
    }
  }

  async function handleCancelDeleteComment(): Promise<void> {
    setShowDeleteCommentConfirm(false);
    setPendingDeleteCommentId(null);
    setDeleteCommentImpact(null);
  }

  async function handleSendTaskMail(body: string, interrupt: boolean) {
    if (route.kind !== "detail") {
      return;
    }
    setSendingTaskMail(true);
    setTaskActionError(null);
    try {
      await orchestraClient.inbox.send({
        projectId: taskDetail?.projectId ?? projectId ?? null,
        taskId: route.taskId,
        recipientType: "active_assignment",
        body,
        priority: interrupt ? "interrupt" : "normal",
      });
      await loadTaskDetail(route.taskId);
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to send task mail."));
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
      await orchestraClient.tasks.dispatch(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to dispatch task lane.");
  }

  function openMobileCompletionConfirm(outcome: "success" | "failure") {
    setMobileCompletionOutcome(outcome);
    setMobileCompletionSummary("");
    setMobileCompletionNotes("");
  }

  async function handleCompleteLane(
    outcome: "success" | "failure" | "needs_user",
    summary: string,
    notes?: string,
  ) {
    if (route.kind !== "detail") {
      return;
    }
    const actionId = outcome === "success" ? "approve-user" : outcome === "failure" ? "needs-work-user" : "needs-user";
    await runDetailAction(actionId, async () => {
      if (outcome === "success") {
        await orchestraClient.tasks.complete(route.taskId, "success", summary, notes);
      } else if (outcome === "failure") {
        await orchestraClient.tasks.complete(route.taskId, "failure", summary, notes);
      } else {
        await orchestraClient.tasks.complete(route.taskId, "needs_user", summary, notes);
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
      await orchestraClient.tasks.approveReview(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to approve task lane.");
  }

  async function handleRelaneTask(targetLaneId: string, notes?: string) {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("relane", async () => {
      await orchestraClient.tasks.reassign(route.taskId, targetLaneId, notes);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to re-lane task.");
  }

  async function handleSendLaneBackForWork() {
    if (route.kind !== "detail") {
      return;
    }
    const effectiveAssignmentStatus = taskDetail ? getEffectiveTaskDetailAssignmentStatus(taskDetail) : null;
    const shouldResume = ["awaiting_user_intervention", "paused_by_user"].includes(effectiveAssignmentStatus ?? "");
    const actionId = shouldResume ? "resume-pending" : "needs-work-pending";
    await runDetailAction(actionId, async () => {
      if (shouldResume) {
        await orchestraClient.tasks.resume(route.taskId);
      } else {
        await orchestraClient.tasks.markNeedsWork(route.taskId);
      }
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, shouldResume
      ? "Unable to resume task lane."
      : "Unable to mark task as needing work.");
  }

  async function handlePauseTaskRuntime() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("pause", async () => {
      await orchestraClient.tasks.pause(route.taskId);
      await loadTasksData();
      await loadTaskDetail(route.taskId);
    }, "Unable to pause task lane.");
  }

  async function handleWhipTask() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("whip", async () => {
      const activeSessionId = taskDetail?.activeLaneAssignment?.sessionId ?? null;
      if (activeSessionId) {
        await orchestraClient.sessions.sendMessage(
          activeSessionId,
          `Keep working until you are done - when you are done use tool \`complete_lane_as_success\` (with the task ID, required lane summary, and optional notes) unless you truly failed - then use tool \`complete_lane_as_failure\` (with task ID, required lane summary, required \`actuallyFailed\`, and optional notes). Pass \`actuallyFailed=false\` only when you finished this slice but are not actually failed and want Orchestra to guide the next slice. If you truly need the user - use tool \`request_user_intervention\` (with task ID, required lane summary, required \`actuallyBlocked\`, and optional notes). Pass \`actuallyBlocked=false\` only when you finished this slice but are not actually blocked and want Orchestra to guide the next slice.\n\nCanonical task ID: ${route.taskId}`,
          `manual-whip-${Date.now()}`,
        );
      }
      const updatedTask = await orchestraClient.tasks.manualWhip(route.taskId);
      setTaskDetail((current) => (sameData(current, updatedTask) ? current : updatedTask));
      await loadTasksData();
      await loadTaskDetail(route.taskId, { preserveDraft: true, silent: true });
    }, "Unable to send manual task whip.");
  }

  async function handleResetTaskRuntime() {
    if (route.kind !== "detail") {
      return;
    }
    await runDetailAction("reset", async () => {
      await orchestraClient.tasks.resetRuntime(route.taskId);
      let refreshedTask = await orchestraClient.tasks.get(route.taskId);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (refreshedTask.status === "ready" && !refreshedTask.activeLaneAssignment) {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        refreshedTask = await orchestraClient.tasks.get(route.taskId);
      }
      setTaskDetail((current) => (sameData(current, refreshedTask) ? current : refreshedTask));
      setTaskDraft((current) => {
        const nextDraft = taskToDraft(refreshedTask);
        return sameData(current, nextDraft) ? current : nextDraft;
      });
      setTaskDraftDirty(false);
      await loadTasksData();
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
        await orchestraClient.sessions.sendMessage(
          activeSessionId,
          "Keep working this ticket and use complete_lane_as_success, complete_lane_as_failure (with actuallyFailed), or request_user_intervention (with actuallyBlocked) with a concise lane summary when you are ready to transition.",
          `retry-task-${taskDetail.id}-${Date.now()}`,
        );
        return;
      }

      if (taskDetail.readyForDispatch) {
        await orchestraClient.tasks.dispatch(taskDetail.id);
        await loadTasksData();
        await loadTaskDetail(taskDetail.id);
        return;
      }

      throw new Error("This task is not currently dispatchable for retry.");
    } catch (error) {
      setTaskActionError(toUiErrorState(error, "Unable to retry task lane."));
    }
  }

  const retryCurrentRouteLoad = useCallback(() => {
    if (route.kind === "detail") {
      void loadTaskDetail(route.taskId);
      return;
    }
    if (route.kind === "schedule") {
      void loadTaskScheduleDetail(route.scheduleId);
      return;
    }
    void loadTasksData();
  }, [loadTaskDetail, loadTaskScheduleDetail, loadTasksData, route]);

  const detailHeaderActions = taskDetail
    ? buildTaskDetailHeaderActions({
        task: taskDetail,
        canPublish: taskDetail.status === "draft" && Boolean(taskDraft.workflowId && taskDraft.title.trim()) && !publishingTask && !savingTask && !loadingTaskDetail,
        effectiveActiveLaneAssignmentStatus: getEffectiveTaskDetailAssignmentStatus(taskDetail),
        onPublish: () => void handlePublishDetailTask(),
        onDispatch: () => void handleDispatchTaskLane(),
        onApproveCompletion: () => void handleApproveLaneCompletion(),
        onSendBackForWork: () => void handleSendLaneBackForWork(),
        onResetTask: () => void handleResetTaskRuntime(),
        onComplete: openMobileCompletionConfirm,
        onPauseRuntime: () => void handlePauseTaskRuntime(),
        onWhipTask: () => void handleWhipTask(),
      })
    : [];
  const taskDetailOpenSessionTarget = taskDetail
    ? getTaskOpenSessionTarget(taskDetail)
    : null;
  const taskDetailMobileHeaderActions = taskDetailOpenSessionTarget
    ? [
        ...detailHeaderActions,
        {
          id: "open-session",
          label: "Open session",
          onClick: () => (onOpenTaskSession ?? onOpenSession ?? (() => {}))(taskDetailOpenSessionTarget.sessionId, taskDetailOpenSessionTarget.projectId),
          variant: "secondary" as const,
          dataRole: "task-open-session",
        },
      ]
    : detailHeaderActions;

  const mobileHeaderContextBase = (() => {
    switch (route.kind) {
      case "create": {
        const canSave = creatingScheduledTask ? Boolean(taskScheduleDraft.task.title.trim()) : Boolean(taskDraft.title.trim());
        const canPublish = creatingScheduledTask ? canSave : Boolean(taskDraft.workflowId && taskDraft.title.trim());
        return {
          title: creatingScheduledTask ? "New scheduled task" : "New task",
          backLabel: "Back to tasks",
          onBack: () => setRoute({ kind: "overview" as const }),
          actionMenuLabel: creatingScheduledTask ? "Create schedule" : "Create task",
          actions: [
            {
              id: "publish",
              label: (savingTask || publishingTask) ? (creatingScheduledTask ? "Creating…" : "Publishing…") : (creatingScheduledTask ? "Create schedule" : "Publish"),
              disabled: savingTask || publishingTask || !canPublish,
              variant: "secondary" as const,
            },
            {
              id: "save",
              label: (savingTask || publishingTask) ? "Saving…" : (creatingScheduledTask ? "Save schedule" : "Save changes"),
              disabled: savingTask || publishingTask || !canSave,
              variant: "primary" as const,
            },
          ],
          onAction: (actionId: string) => {
            if (actionId === "publish") {
              void handlePublishCreateTask();
              return;
            }
            if (actionId === "save") {
              void handleSaveCreateTask();
            }
          },
        };
      }
      case "schedule": {
        if (!taskScheduleDetail) {
          return {
            title: "Task schedule",
            backLabel: "Back to tasks",
            onBack: () => setRoute({ kind: "overview" as const }),
          };
        }
        return {
          title: taskScheduleEditing ? "Edit schedule" : (taskScheduleDraft.task.title.trim() || taskScheduleDetail.title),
          backLabel: "Back to tasks",
          onBack: () => setRoute({ kind: "overview" as const }),
        };
      }
      case "detail": {
        if (!taskDetail) {
          return {
            title: "Task detail",
            backLabel: "Back to tasks",
            onBack: returnToOverviewFromTaskDetail,
          };
        }
        if (taskDetailEditing || taskDetailMobileHeaderActions.length === 0) {
          return {
            title: taskDetailEditing ? "Edit task" : (taskDraft.title.trim() || taskDetail.title),
            backLabel: "Back to tasks",
            onBack: returnToOverviewFromTaskDetail,
          };
        }
        return {
          title: taskDraft.title.trim() || taskDetail.title,
          backLabel: "Back to tasks",
          onBack: returnToOverviewFromTaskDetail,
          actionMenuLabel: "Task actions",
          actions: stripMobileHeaderActionData(taskDetailMobileHeaderActions),
          onAction: (actionId: string) => {
            taskDetailMobileHeaderActions.find((action) => action.id === actionId)?.onClick();
          },
        };
      }
      default:
        return null;
    }
  })();

  const mobileHeaderSignature = mobileHeaderContextBase
    ? JSON.stringify({
        title: mobileHeaderContextBase.title,
        backLabel: mobileHeaderContextBase.backLabel,
        actionMenuLabel: mobileHeaderContextBase.actionMenuLabel ?? null,
        actions: mobileHeaderContextBase.actions ?? [],
      })
    : null;

  useEffect(() => {
    if (!onMobileHeaderContextChange) {
      return;
    }
    if (!mobileHeaderContextBase || !mobileHeaderSignature) {
      onMobileHeaderContextChange(null);
      return;
    }
    onMobileHeaderContextChange({
      ...mobileHeaderContextBase,
      signature: mobileHeaderSignature,
    });
  }, [mobileHeaderContextBase, mobileHeaderSignature, onMobileHeaderContextChange]);

  useEffect(() => () => {
    onMobileHeaderContextChange?.(null);
  }, [onMobileHeaderContextChange]);

  if (typeof window !== "undefined") {
    const testWindow = window as typeof window & {
      __orchestraTestOpenTaskDetail?: (taskId: string) => void;
      __orchestraTasksScrollDebug?: {
        routeKind: TasksRoute["kind"];
        previousRouteKind: TasksRoute["kind"];
        shouldRestore: boolean;
        savedTop: number;
        savedKind: OverviewScrollTarget["kind"];
      };
    };
    testWindow.__orchestraTestOpenTaskDetail = openTaskDetail;
    testWindow.__orchestraTasksScrollDebug = {
      routeKind: route.kind,
      previousRouteKind: previousRouteKindRef.current,
      shouldRestore: shouldRestoreOverviewScrollRef.current,
      savedTop: savedOverviewScrollTopRef.current,
      savedKind: savedOverviewScrollTargetKindRef.current,
    };
  }

  return (
    <section className="panel-stack task-page-stack task-page-stack--with-fab" ref={pageRootRef}>
      <ResourceStatusBanner
        connection={connection}
        error={taskActionError}
        hasData={tasks.length > 0 || taskSchedules.length > 0}
        refreshing={refreshingTasks}
        onRetry={retryCurrentRouteLoad}
        retryLabel="Retry tasks"
        refreshingLabel="Refreshing task data…"
        dataRolePrefix="tasks-status"
      />
      {loadingTasks && tasks.length === 0 && taskSchedules.length === 0 ? <p className="muted-copy">Loading tasks…</p> : null}

      {route.kind === "overview" ? (
        <TasksOverviewPage
          agents={agents}
          attentionTasks={attentionTasks}
          availableTags={availableTags}
          board={boardModel}
          onOpenTask={openTaskDetail}
          onOpenSchedule={openTaskScheduleDetail}
          onOpenTag={openTaskTagHandler}
          onOverviewStateChange={updateTaskOverviewState}
          overviewState={taskOverviewState}
          roles={roles}
          schedules={taskSchedules}
          tagScopedTasks={tagScopedTasks}
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
          onEditingStateChange={setTaskScheduleEditing}
          taskLookup={entityLookup.tasks}
          repositories={repositories}
          roles={roles}
          saving={savingTask}
          schedule={taskScheduleDetail}
          workflows={workflowSummaries}
        />
      ) : route.kind === "detail" && taskDetailRenderState !== "loading" && taskDetail ? (
        <div className="task-detail-route-loading-shell">
          <TaskDetailPage
            agents={agents}
            commentDraft={commentDraft}
            tasks={tasks}
            deleting={deletingTask}
            closing={closingTask}
            dependencyCandidates={dependencyCandidates.map((task) => ({ id: task.id, number: task.number, title: task.title }))}
            draft={taskDraft}
            fileReferenceDraft={fileReferenceDraft}
            dependencyTree={dependencyTree}
            dependencyTreeLoading={loadingDependencyTree}
            dependencyViewMode={dependencyViewMode}
            loading={loadingTaskDetail || taskDetailRenderState === "detail_pending"}
            onAddAttachment={(files) => void handleAttachmentInputChange(files)}
            onDownloadAttachment={(attachmentId) => void handleDownloadAttachment(attachmentId)}
            onAddComment={handleAddComment}
            onAddTaskTodo={(description, laneId) => void handleAddTaskTodo(description, laneId)}
            onDeleteComment={handleDeleteComment}
            onDeleteTaskTodo={(todoId) => void handleDeleteTaskTodo(todoId)}
            onAddDependency={() => void handleAddDependency()}
            onAddFileReference={() => void handleAddFileReference()}
            onApproveCompletion={() => void handleApproveLaneCompletion()}
            onCommentDraftChange={setCommentDraft}
            onCommentsTabViewed={() => void handleMarkTaskCommentsReadForUser()}
            onComplete={(outcome, summary, notes) => void handleCompleteLane(outcome, summary, notes)}
            onCancelEdit={handleCancelDetailEdit}
            onClose={(reason) => void handleCloseDetailTask(reason)}
            onDelete={() => void handleDeleteDetailTask()}
            onDispatch={() => void handleDispatchTaskLane()}
            onDraftChange={(draft) => {
              setTaskDraft(draft);
              setTaskDraftDirty(true);
            }}
            onFileReferenceDraftChange={setFileReferenceDraft}
            onDependencyViewModeChange={setDependencyViewMode}
            onOpenTask={openTaskDetail}
            onOpenTag={openTaskTagHandler}
            onOpenSession={openSessionHandler}
            onOpenTaskSession={openTaskSessionHandler}
            onOpenAgent={openAgentHandler}
            onOpenRole={openRoleHandler}
            entityLookup={entityLookup}
            onPublish={() => void handlePublishDetailTask()}
            onUpdateComment={handleUpdateComment}
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
            onEditingStateChange={setTaskDetailEditing}
          />
          {taskDetailRenderState === "detail_pending" ? (
            <div className="task-detail-route-loading-overlay" data-role="task-detail-route-loading-overlay" aria-live="polite">
              <section className="panel task-detail-route-loading-card" aria-busy="true">
                <p className="eyebrow">Opening task</p>
                <h3>Loading exact task detail</h3>
                <p>Keeping the current detail shell stable while the selected task hydrates.</p>
              </section>
            </div>
          ) : null}
        </div>
      ) : route.kind === "detail" ? (
        <section className="task-page task-detail-page panel task-detail-loading-panel" data-role="task-detail-loading-panel" aria-busy="true">
          <div className="panel__header panel__header--session-detail task-detail-primary-header">
            <div className="task-detail-primary-header__copy">
              <div className="empty-state__loading-visual task-detail-loading-visual" aria-hidden="true">
                <span className="empty-state__loading-pill task-detail-loading-pill" />
                <span className="empty-state__loading-line empty-state__loading-line--title task-detail-loading-line--title" />
                <span className="empty-state__loading-line task-detail-loading-line" />
              </div>
            </div>
          </div>
          <div className="task-detail-loading-copy">
            <p className="eyebrow">Opening task</p>
            <h3>Loading task detail</h3>
            <p>Preparing the selected task without shifting the page layout.</p>
          </div>
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

      {showCreateFab && route.kind !== "create" && route.kind !== "detail" ? (
        <div className="page-fab page-fab--tasks" data-role="tasks-create-fab">
          <button
            className="primary-button page-fab__button"
            data-role="new-task"
            type="button"
            {...getTooltipProps("Create a new task draft in the active project.")}
            onClick={() => openCreateTask()}
          >
            <span className="page-fab__icon" aria-hidden="true">+</span>
            <span className="page-fab__label">New task</span>
          </button>
        </div>
      ) : null}

      {mobileCompletionOutcome && route.kind === "detail" && taskDetail ? (
        <div className="quick-chat-overlay" data-role="tasks-mobile-completion-confirm-overlay" onClick={() => !detailActionPending && setMobileCompletionOutcome(null)}>
          <section className="quick-chat-modal panel task-delete-confirm" data-role="tasks-mobile-completion-confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Lane transition summary</p>
                <h3>{mobileCompletionOutcome === "success" ? `Complete ${taskDetail.number} as success?` : `Complete ${taskDetail.number} as failure?`}</h3>
              </div>
            </div>
            <p>Orchestra requires a concise lane summary whenever you close this lane transition.</p>
            <label className="field-group">
              <span className="field-group__label">Lane summary</span>
              <textarea
                className="text-area"
                data-role="tasks-mobile-completion-summary"
                rows={3}
                value={mobileCompletionSummary}
                onChange={(event) => setMobileCompletionSummary(event.target.value)}
                placeholder="Summarize what happened in this lane"
              />
            </label>
            <label className="field-group">
              <span className="field-group__label">Notes (optional)</span>
              <textarea
                className="text-area"
                data-role="tasks-mobile-completion-notes"
                rows={3}
                value={mobileCompletionNotes}
                onChange={(event) => setMobileCompletionNotes(event.target.value)}
                placeholder="Add any extra detail reviewers should know"
              />
            </label>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" disabled={Boolean(detailActionPending)} onClick={() => setMobileCompletionOutcome(null)}>
                Cancel
              </button>
              <button
                className="primary-button"
                data-role="tasks-mobile-completion-confirm"
                type="button"
                disabled={Boolean(detailActionPending) || !mobileCompletionSummary.trim()}
                onClick={() => {
                  const outcome = mobileCompletionOutcome;
                  if (!outcome || !mobileCompletionSummary.trim()) {
                    return;
                  }
                  void handleCompleteLane(outcome, mobileCompletionSummary.trim(), mobileCompletionNotes.trim() || undefined);
                  setMobileCompletionOutcome(null);
                  setMobileCompletionSummary("");
                  setMobileCompletionNotes("");
                }}
              >
                Continue
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showDeleteCommentConfirm && pendingDeleteCommentId ? (
        <div className="quick-chat-overlay" data-role="task-comment-delete-confirm-overlay" onClick={() => !deletingComment && handleCancelDeleteComment()}>
          <section className="quick-chat-modal panel task-comment-delete-confirm" data-role="task-comment-delete-confirm" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Delete comment</p>
                <h3>Delete this comment?</h3>
              </div>
            </div>
            <p>
              This will permanently delete the comment and all related data. This action cannot be undone.
            </p>
            {deleteCommentImpact && (
              <div className="task-comment-delete-impact">
                <p className="eyebrow">Impact</p>
                <ul>
                  <li><strong>{deleteCommentImpact.replyCount}</strong> {deleteCommentImpact.replyCount === 1 ? "reply" : "replies"} will be deleted</li>
                  {deleteCommentImpact.attachmentCount > 0 && (
                    <li><strong>{deleteCommentImpact.attachmentCount}</strong> attachment{deleteCommentImpact.attachmentCount !== 1 ? "s" : ""} will be deleted</li>
                  )}
                  {deleteCommentImpact.fileReferenceCount > 0 && (
                    <li><strong>{deleteCommentImpact.fileReferenceCount}</strong> file reference{deleteCommentImpact.fileReferenceCount !== 1 ? "s" : ""} will be deleted</li>
                  )}
                  <li><strong>Total records affected:</strong> {deleteCommentImpact.cascadeDeletedCount}</li>
                </ul>
              </div>
            )}
            <div className="action-cluster action-cluster--wrap">
              <button
                className="secondary-button"
                type="button"
                disabled={deletingComment || loadingDeleteCommentImpact}
                onClick={handleCancelDeleteComment}
              >
                Cancel
              </button>
              <button
                className="secondary-button secondary-button--danger"
                data-role="confirm-delete-comment"
                type="button"
                disabled={deletingComment || loadingDeleteCommentImpact}
                onClick={handleConfirmDeleteComment}
              >
                {deletingComment ? "Deleting…" : "Delete comment"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
