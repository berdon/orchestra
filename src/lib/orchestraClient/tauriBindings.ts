import { invoke } from "@tauri-apps/api/core";

import {
  attachRepositoryRemote,
  createProject,
  createRepository,
  deleteProject,
  deleteRepository,
  getActiveProjectId,
  getProject,
  getRepository,
  listProjects,
  listRepositories,
  setProjectDefaultRepository,
  updateProject,
  updateRepository,
} from "../projects";
import {
  getProjectSourceControlSettings,
  getSourceControlSettings,
  updateProjectSourceControlSettings,
  updateSourceControlSettings,
} from "../sourceControlSettings";
import {
  createProjectSecret,
  deleteProjectSecret,
  getProjectSecrets,
  getSessionPromptSettings,
  getTaskAutomationSettings,
  getWorkerOverlay,
  updateProjectSecret,
  updateSessionPromptSettings,
  updateTaskAutomationSettings,
  updateWorkerOverlay,
} from "../projectSettings";
import {
  archiveAgent,
  createAgent,
  deleteAgentQueueEntry,
  enqueueAgentWork,
  ensureAgentSession,
  getAgent,
  getAgentMemoryInfo,
  getAgentOperations,
  listAgentOperations,
  updateAgent,
  updateAgentMainSession,
  validateAgent,
} from "../agents";
import {
  archiveRole,
  createRole,
  getRole,
  updateRole,
  validateRole,
} from "../roles";
import {
  deleteRoleQueueEntry,
  dispatchRoleQueue,
  disposeRoleInstance,
  enqueueRoleWork,
  getRoleOperations,
  listRoleOperations,
  releaseRoleInstance,
  resetRoleAssignments,
} from "../roleRuntime";
import {
  getAgentPermissions,
  getPolicy,
  getRolePermissions,
  listPolicies,
} from "../policies";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannelActivity,
  listChannels,
  listTelegramChatCandidates,
  updateChannel,
  validateTelegramBot,
} from "../channels";
import { getPiExecutableDiagnostic, listPiModels } from "../tauri";
import { normalizeTaskTags } from "../taskTags";
import {
  copyProjectNote,
  copyProjectNotesDirectory,
  createProjectNotesDirectory,
  deleteProjectNote,
  deleteProjectNotesDirectory,
  getProjectNote,
  listProjectNotes,
  moveProjectNote,
  moveProjectNotesDirectory,
  updateProjectNote,
} from "../projectNotes";
import { createDownloadBlob } from "./browserDownloads";
import { normalizeTaskAttachmentUploadInput } from "../taskAttachments";
import type {
  AgentSkillLinks,
  AgentSummary,
  AppInfo,
  ArchiveMailboxMessagesInput,
  LocalSkillUpsertInput,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  ProjectDetail,
  ProjectSummary,
  QueuedSessionMessage,
  RoleSkillLinks,
  RoleSummary,
  SendMailboxMessageInput,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionSendMode,
  SessionStats,
  SkillBindingInput,
  SkillDetail,
  SkillSummary,
  SkillsCatalogDiagnostics,
  TaskAttachment,
  TaskAttachmentContent,
  TaskAttachmentContentPayload,
  TaskAttachmentUploadInput,
  TaskBrowserSession,
  TaskComment,
  TaskCommentDeleteImpact,
  TaskCommentFileMentionCandidate,
  TaskCommentInput,
  TaskCommentUpdateInput,
  TaskDependency,
  TaskDetail,
  TaskFileReference,
  TaskFileReferenceInput,
  TaskPullRequestDetail,
  TaskListOptions,
  TaskScheduleDetail,
  TaskScheduleSummary,
  TaskScheduleUpsertInput,
  TaskSummary,
  TaskTodo,
  TaskTodoInput,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowSkillLinks,
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
  summary: string,
  notes?: string,
) {
  switch (outcome) {
    case "success":
      return invokeTauri<TaskDetail>("complete_lane_as_success", { taskId, summary, notes });
    case "failure":
      return invokeTauri<TaskDetail>("complete_lane_as_failure", {
        taskId,
        summary,
        actuallyFailed: true,
        notes,
      });
    case "needs_user":
      return invokeTauri<TaskDetail>("request_user_intervention", {
        taskId,
        summary,
        actuallyBlocked: true,
        notes,
      });
    default:
      return invokeTauri<TaskDetail>("request_user_intervention", {
        taskId,
        summary,
        actuallyBlocked: true,
        notes,
      });
  }
}

export const tauriOrchestraClientServiceBindings: OrchestraClientServiceBindings = {
  app: {
    getInfo: () => invokeTauri<AppInfo>("get_app_info"),
    reportError: reportClientError,
  },
  catalog: {
    listProjects,
    getProject,
    listAgents: (includeArchived = false, projectId) =>
      invokeTauri<AgentSummary[]>("list_agents", { includeArchived, projectId: projectId ?? null }),
    listRoles: (includeArchived = false) =>
      invokeTauri<RoleSummary[]>("list_roles", { includeArchived }),
    listWorkflows: (includeArchived = false) =>
      invokeTauri<WorkflowSummary[]>("list_workflows", { includeArchived }),
    getWorkflow: (workflowId) => invokeTauri<WorkflowDefinition>("get_workflow", { workflowId }),
  },
  projects: {
    createProject,
    updateProject,
    deleteProject,
    listRepositories,
    getRepository,
    createRepository,
    updateRepository,
    deleteRepository,
    attachRepositoryRemote,
    setProjectDefaultRepository,
  },
  settings: {
    listPiModels,
    getPiExecutableDiagnostic,
    getSourceControlSettings,
    updateSourceControlSettings,
    getProjectSourceControlSettings,
    updateProjectSourceControlSettings,
    getSessionPromptSettings,
    updateSessionPromptSettings,
    getTaskAutomationSettings,
    updateTaskAutomationSettings,
    getWorkerOverlay,
    updateWorkerOverlay,
    getProjectSecrets,
    createProjectSecret,
    updateProjectSecret,
    deleteProjectSecret,
  },
  workers: {
    validateAgent,
    getAgent,
    createAgent,
    updateAgent,
    archiveAgent,
    getAgentMemoryInfo,
    listAgentOperations,
    getAgentOperations,
    ensureAgentSession,
    updateAgentMainSession,
    enqueueAgentWork,
    deleteAgentQueueEntry,
    getAgentPermissions,
    validateRole,
    getRole,
    createRole,
    updateRole,
    archiveRole,
    listRoleOperations,
    getRoleOperations,
    enqueueRoleWork,
    dispatchRoleQueue,
    deleteRoleQueueEntry,
    resetRoleAssignments,
    releaseRoleInstance,
    disposeRoleInstance,
    getRolePermissions,
  },
  workflows: {
    validateWorkflow: (input) => invokeTauri("validate_workflow", { input }),
    createWorkflow: (input) => invokeTauri("create_workflow", { input }),
    updateWorkflow: (workflowId, input) => invokeTauri("update_workflow", { workflowId, input }),
    duplicateWorkflow: (workflowId, newName) => invokeTauri("duplicate_workflow", { workflowId, newName: newName ?? null }),
    archiveWorkflow: (workflowId) => invokeTauri("archive_workflow", { workflowId }),
    getWorkflowDeleteImpact: (workflowId) => invokeTauri("get_workflow_delete_impact", { workflowId }),
    deleteWorkflow: (workflowId) => invokeTauri("delete_workflow", { workflowId }),
  },
  policies: {
    listPolicies,
    getPolicy,
  },
  channels: {
    listChannels,
    getChannel,
    listChannelActivity,
    createChannel,
    updateChannel,
    deleteChannel,
    validateTelegramBot,
    listTelegramChatCandidates,
  },
  skills: {
    listSkills: (includeArchived = false) => invokeTauri<SkillSummary[]>("list_skills", { includeArchived }),
    getSkill: (skillId) => invokeTauri<SkillDetail>("get_skill", { skillId }),
    getCatalogDiagnostics: () => invokeTauri<SkillsCatalogDiagnostics>("get_skills_catalog_diagnostics"),
    createLocalSkill: (input: LocalSkillUpsertInput) => invokeTauri<SkillDetail>("create_local_skill", { input }),
    updateLocalSkill: (skillId, input: LocalSkillUpsertInput) => invokeTauri<SkillDetail>("update_local_skill", { skillId, input }),
    archiveLocalSkill: (skillId) => invokeTauri<SkillDetail>("archive_local_skill", { skillId }),
    unarchiveLocalSkill: (skillId) => invokeTauri<SkillDetail>("unarchive_local_skill", { skillId }),
    deleteLocalSkill: (skillId) => invokeTauri<SkillDetail>("delete_local_skill", { skillId }),
    refreshExternalSkills: () => invokeTauri<SkillSummary[]>("refresh_external_skills"),
    setSkillBindings: (skillId, bindings: SkillBindingInput[]) => invokeTauri<SkillDetail>("set_skill_bindings", { skillId, bindings }),
    getRoleSkillLinks: (roleId) => invokeTauri<RoleSkillLinks>("get_role_skill_links", { roleId }),
    getAgentSkillLinks: (agentId) => invokeTauri<AgentSkillLinks>("get_agent_skill_links", { agentId }),
    getWorkflowSkillLinks: (workflowId) => invokeTauri<WorkflowSkillLinks>("get_workflow_skill_links", { workflowId }),
  },
  notes: {
    list: listProjectNotes,
    get: getProjectNote,
    update: updateProjectNote,
    delete: deleteProjectNote,
    copy: copyProjectNote,
    move: moveProjectNote,
    createDirectory: createProjectNotesDirectory,
    deleteDirectory: deleteProjectNotesDirectory,
    copyDirectory: copyProjectNotesDirectory,
    moveDirectory: moveProjectNotesDirectory,
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
    showBrowser: (taskId) => invokeTauri<TaskBrowserSession>("show_task_browser", { taskId }),
    getBrowserState: (taskId) => invokeTauri<TaskBrowserSession>("get_task_browser_state", { taskId }),
    navigateBrowser: (taskId, url) => invokeTauri<TaskBrowserSession>("navigate_task_browser", { taskId, url }),
    setBrowserInspectMode: (taskId, enabled) => invokeTauri<TaskBrowserSession>("set_task_browser_inspect_mode", { taskId, enabled }),
    revealBrowserDomAnchor: (taskId, anchor) => invokeTauri<TaskBrowserSession>("reveal_task_browser_dom_anchor", { taskId, anchor }),
    getCommentDeleteImpact: (commentId) => invokeTauri<TaskCommentDeleteImpact>("get_task_comment_delete_impact", { commentId }),
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
    getPullRequest: (taskId) => invokeTauri<TaskPullRequestDetail>("get_task_pull_request", { taskId }),
    addAttachment: async (taskId, input: TaskAttachmentUploadInput) => {
      const normalizedInput = await normalizeTaskAttachmentUploadInput(input);
      return invokeTauri<TaskAttachment>("add_task_attachment", { taskId, input: normalizedInput });
    },
    getAttachmentContent: async (attachmentId) => {
      const payload = await invokeTauri<TaskAttachmentContentPayload>("get_task_attachment_content", { attachmentId });
      return {
        fileName: payload.fileName,
        mediaType: payload.mediaType,
        blob: createDownloadBlob(payload.base64Data, payload.mediaType),
      } satisfies TaskAttachmentContent;
    },
    downloadAttachment: async (attachmentId) => {
      await invokeTauri<string | null>("download_task_attachment", { attachmentId });
    },
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
    create: (title, projectSlug, agentId) =>
      invokeTauri<SessionRecord>("create_session", { title, projectSlug, agentId: agentId ?? null }),
    createContextual: (sessionId, projectSlug, agentId) =>
      invokeTauri<SessionRecord>("create_contextual_session", { sessionId, projectSlug, agentId: agentId ?? null }),
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
    sendMessage: (sessionId, message, runId, sendMode) =>
      invokeTauri<QueuedSessionMessage>("send_session_message", { sessionId, message, runId, sendMode: sendMode ?? null }),
  },
};
