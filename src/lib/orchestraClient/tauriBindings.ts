import { invoke } from "@tauri-apps/api/core";

import { getActiveProjectId } from "../projects";
import { normalizeTaskTags } from "../taskTags";
import type {
  AgentSummary,
  AppInfo,
  ArchiveMailboxMessagesInput,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  ProjectDetail,
  ProjectSummary,
  QueuedSessionMessage,
  RoleSummary,
  SendMailboxMessageInput,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionStats,
  TaskAttachment,
  TaskAttachmentInput,
  TaskComment,
  TaskCommentFileMentionCandidate,
  TaskCommentInput,
  TaskCommentUpdateInput,
  TaskDependency,
  TaskDetail,
  TaskFileReference,
  TaskFileReferenceInput,
  TaskListOptions,
  TaskScheduleDetail,
  TaskScheduleSummary,
  TaskScheduleUpsertInput,
  TaskSummary,
  TaskTodo,
  TaskTodoInput,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowSummary,
} from "../../types";
import type { OrchestraTaskCompletionOutcome } from "./client";
import type { OrchestraClientServiceBindings } from "./serviceBindings";

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

function normalizeTaskListOptions(options?: TaskListOptions) {
  return {
    projectId: options?.projectId,
    includeArchived: options?.includeArchived ?? false,
    tags: options?.tags,
    tagMatch: options?.tagMatch ?? "all",
    sortBy: options?.sortBy ?? "updatedAt",
    sortDirection: options?.sortDirection ?? "desc",
  } as const;
}

async function resolveTauriProjectId(projectId?: string | null) {
  const requestedProjectId = projectId ?? getActiveProjectId();
  const projects = await invokeTauri<Array<{ id: string }>>("list_projects");
  if (requestedProjectId && projects.some((entry) => entry.id === requestedProjectId)) {
    return requestedProjectId;
  }

  return projects[0]?.id ?? requestedProjectId ?? null;
}

async function reportClientError(target: string, error: unknown, fallback: string) {
  const message = describeError(error, fallback);
  console.error(`[${target}] ${message}`, error);

  try {
    await invokeTauri<void>("report_client_error", { target, message });
  } catch (loggingError) {
    console.error(`[report_client_error.failed] ${target}`, loggingError);
  }

  return message;
}

async function completeTask(
  taskId: string,
  outcome: OrchestraTaskCompletionOutcome,
  notes?: string,
) {
  switch (outcome) {
    case "success":
      return invokeTauri<TaskDetail>("complete_lane_as_success", { taskId, notes });
    case "failure":
      return invokeTauri<TaskDetail>("complete_lane_as_failure", { taskId, notes });
    case "needs_user":
      return invokeTauri<TaskDetail>("request_user_intervention", { taskId, notes });
    default:
      return invokeTauri<TaskDetail>("request_user_intervention", { taskId, notes });
  }
}

export const tauriOrchestraClientServiceBindings: OrchestraClientServiceBindings = {
  app: {
    getInfo: () => invokeTauri<AppInfo>("get_app_info"),
    reportError: reportClientError,
  },
  catalog: {
    listProjects: () => invokeTauri<ProjectSummary[]>("list_projects"),
    getProject: (projectId) => invokeTauri<ProjectDetail>("get_project", { projectId }),
    listAgents: (includeArchived = false, projectId) =>
      invokeTauri<AgentSummary[]>("list_agents", { includeArchived, projectId: projectId ?? null }),
    listRoles: (includeArchived = false) =>
      invokeTauri<RoleSummary[]>("list_roles", { includeArchived }),
    listWorkflows: (includeArchived = false) =>
      invokeTauri<WorkflowSummary[]>("list_workflows", { includeArchived }),
    getWorkflow: (workflowId) => invokeTauri<WorkflowDefinition>("get_workflow", { workflowId }),
  },
  tasks: {
    list: async (options) => {
      const normalized = normalizeTaskListOptions(options);
      const projectId = await resolveTauriProjectId(normalized.projectId);
      return invokeTauri<TaskSummary[]>("list_tasks", {
        projectId,
        includeArchived: normalized.includeArchived,
        tags: normalized.tags ? normalizeTaskTags(normalized.tags) : undefined,
        tagMatch: normalized.tagMatch,
        sortBy: normalized.sortBy,
        sortDirection: normalized.sortDirection,
      });
    },
    get: (taskId) => invokeTauri<TaskDetail>("get_task", { taskId }),
    create: async (input: TaskUpsertInput, projectId?: string | null) =>
      invokeTauri<TaskDetail>("create_task", {
        projectId: await resolveTauriProjectId(projectId),
        input,
      }),
    update: (taskId, input) => invokeTauri<TaskDetail>("update_task", { taskId, input }),
    remove: (taskId) => invokeTauri<TaskDetail>("delete_task", { taskId }),
    listTodos: (taskId) => invokeTauri<TaskTodo[]>("list_task_todos", { taskId }),
    listUnfinishedTodos: (taskId, laneId) =>
      invokeTauri<TaskTodo[]>("list_unfinished_task_todos", { taskId, laneId: laneId ?? null }),
    addTodo: (taskId, input: TaskTodoInput) => invokeTauri<TaskTodo>("add_task_todo", { taskId, input }),
    markTodoFinished: (todoId) => invokeTauri<TaskTodo>("mark_task_todo_finished", { todoId }),
    markTodoUnfinished: (todoId) => invokeTauri<TaskTodo>("mark_task_todo_unfinished", { todoId }),
    deleteTodo: (todoId) => invokeTauri<TaskTodo>("delete_task_todo", { todoId }),
    listComments: (taskId) => invokeTauri<TaskComment[]>("list_task_comments", { taskId }),
    comment: (taskId, input: TaskCommentInput) => invokeTauri<TaskComment>("comment_on_task", { taskId, input }),
    updateComment: (commentId, input: TaskCommentUpdateInput) => invokeTauri<TaskComment>("update_task_comment", { commentId, input }),
    deleteComment: (commentId) => invokeTauri<TaskComment>("delete_task_comment", { commentId }),
    markCommentsRead: (taskId) => invokeTauri<TaskDetail>("mark_task_comments_read_for_user", { taskId }),
    searchCommentFileMentions: (taskId, query, limit = 10) =>
      invokeTauri<TaskCommentFileMentionCandidate[]>("search_task_comment_file_mentions", { taskId, query, limit }),
    listMessages: (taskId) => invokeTauri<MailboxMessage[]>("list_task_messages", { taskId }),
    addDependency: (blockerTaskId, blockedTaskId) =>
      invokeTauri<TaskDependency>("add_task_dependency", { blockerTaskId, blockedTaskId }),
    removeDependency: (dependencyId) => invokeTauri<TaskDependency>("remove_task_dependency", { dependencyId }),
    listFileReferences: (taskId) => invokeTauri<TaskFileReference[]>("list_task_file_references", { taskId }),
    addFileReference: (taskId, input: TaskFileReferenceInput) => invokeTauri<TaskFileReference>("add_task_file_reference", { taskId, input }),
    setDefaultFileReference: (referenceId) =>
      invokeTauri<TaskFileReference>("set_default_task_file_reference", { referenceId }),
    removeFileReference: (referenceId) => invokeTauri<TaskFileReference>("remove_task_file_reference", { referenceId }),
    getFileContent: (path) => invokeTauri<string>("get_task_file_content", { path }),
    addAttachment: (taskId, input: TaskAttachmentInput) => invokeTauri<TaskAttachment>("add_task_attachment", { taskId, input }),
    removeAttachment: (attachmentId) => invokeTauri<TaskAttachment>("remove_task_attachment", { attachmentId }),
    listSchedules: async (projectId) =>
      invokeTauri<TaskScheduleSummary[]>("list_task_schedules", {
        projectId: await resolveTauriProjectId(projectId),
      }),
    getSchedule: (scheduleId) => invokeTauri<TaskScheduleDetail>("get_task_schedule", { scheduleId }),
    createSchedule: async (input: TaskScheduleUpsertInput, projectId?: string | null) =>
      invokeTauri<TaskScheduleDetail>("create_task_schedule", {
        projectId: await resolveTauriProjectId(projectId),
        input,
      }),
    updateSchedule: (scheduleId, input: TaskScheduleUpsertInput) => invokeTauri<TaskScheduleDetail>("update_task_schedule", { scheduleId, input }),
    deleteSchedule: (scheduleId) => invokeTauri<TaskScheduleDetail>("delete_task_schedule", { scheduleId }),
    dispatch: (taskId) => invokeTauri<TaskDetail>("dispatch_task_lane", { taskId }),
    complete: completeTask,
    approveReview: (taskId) => invokeTauri<TaskDetail>("approve_task_review", { taskId }),
    approveCompletion: (taskId) => invokeTauri<TaskDetail>("approve_lane_completion", { taskId }),
    markNeedsWork: (taskId, notes) => invokeTauri<TaskDetail>("mark_task_needs_work", { taskId, notes }),
    resume: (taskId, notes) => invokeTauri<TaskDetail>("resume_task_lane", { taskId, notes }),
    pause: (taskId, notes) => invokeTauri<TaskDetail>("pause_task_lane", { taskId, notes }),
    stopActivity: (taskId, notes) => invokeTauri<TaskDetail>("stop_task_activity", { taskId, notes }),
    reassign: (taskId, laneId, notes) => invokeTauri<TaskDetail>("reassign_task_to_lane", { taskId, laneId, notes }),
    manualWhip: (taskId) => invokeTauri<TaskDetail>("manual_task_whip", { taskId }),
    resetRuntime: (taskId) => invokeTauri<TaskDetail>("reset_task_runtime", { taskId }),
  },
  inbox: {
    list: (projectId, includeArchived = false) =>
      invokeTauri<MailboxMessage[]>("list_inbox_messages", { projectId: projectId ?? null, includeArchived }),
    send: (input: SendMailboxMessageInput) => invokeTauri<MailboxMessage>("send_mailbox_message", { input }),
    markRead: (input: MarkMailboxMessagesReadInput) =>
      invokeTauri<MailboxMessage[]>("mark_mailbox_messages_read", { input }),
    archive: (input: ArchiveMailboxMessagesInput) =>
      invokeTauri<MailboxMessage[]>("archive_mailbox_messages", { input }),
  },
  sessions: {
    list: (projectId) => invokeTauri<SessionRecord[]>("list_sessions", { projectId: projectId ?? null }),
    get: (sessionId) => invokeTauri<SessionRecord>("get_session_record", { sessionId }),
    getRuntimeDetails: (sessionId) =>
      invokeTauri<SessionRuntimeDetails>("get_session_runtime_details", { sessionId }),
    getStats: (sessionId) => invokeTauri<SessionStats>("get_session_stats", { sessionId }),
    create: (title, projectSlug) => invokeTauri<SessionRecord>("create_session", { title, projectSlug }),
    createContextual: (sessionId, projectSlug) =>
      invokeTauri<SessionRecord>("create_contextual_session", { sessionId, projectSlug }),
    remove: (sessionId) => invokeTauri<void>("delete_session", { sessionId }),
    resume: (sessionId) => invokeTauri<SessionRecord>("resume_session", { sessionId }),
    subscribe: (sessionId) => invokeTauri<SessionRecord>("subscribe_session", { sessionId }),
    unsubscribe: (sessionId) => invokeTauri<SessionRecord>("unsubscribe_session", { sessionId }),
    stopRuntime: (sessionId, notes) => invokeTauri<SessionRecord>("stop_session_runtime", { sessionId, notes }),
    getModelState: (sessionId) => invokeTauri<SessionModelState>("get_session_model_state", { sessionId }),
    setModel: (sessionId, provider, modelId) =>
      invokeTauri<SessionModelState>("set_session_model", { sessionId, provider, modelId }),
    compact: (sessionId, customInstructions) =>
      invokeTauri<SessionRecord>("compact_session", { sessionId, customInstructions: customInstructions ?? null }),
    reload: (sessionId) => invokeTauri<SessionRecord>("reload_session", { sessionId }),
    sendMessage: (sessionId, message, runId) =>
      invokeTauri<QueuedSessionMessage>("send_session_message", { sessionId, message, runId }),
  },
};
