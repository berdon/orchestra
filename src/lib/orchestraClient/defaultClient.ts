import { listAgents } from "../agents";
import { listProjects, getProject } from "../projects";
import { listRoles } from "../roles";
import {
  addTaskAttachment,
  addTaskDependency,
  addTaskFileReference,
  addTaskTodo,
  approveLaneCompletion,
  approveTaskReview,
  archiveMailboxMessages,
  commentOnTask,
  completeLaneAsFailure,
  completeLaneAsSuccess,
  createContextualSession,
  createSession,
  createTask,
  createTaskSchedule,
  deleteSession,
  deleteTask,
  deleteTaskComment,
  deleteTaskSchedule,
  deleteTaskTodo,
  dispatchTaskLane,
  getAppInfo,
  getSessionModelState,
  getSessionRecord,
  getSessionRuntimeDetails,
  getSessionStats,
  getTask,
  getTaskFileContent,
  getTaskSchedule,
  getWorkflow,
  isTauriAvailable,
  listInboxMessages,
  listSessions,
  listTaskComments,
  listTaskFileReferences,
  listTaskMessages,
  listTaskSchedules,
  listTaskTodos,
  listTasks,
  listUnfinishedTaskTodos,
  listWorkflows,
  listenToInboxChanges,
  listenToSessionChanges,
  listenToSessionStream,
  listenToTaskChanges,
  manualTaskWhip,
  markMailboxMessagesRead,
  markTaskCommentsReadForUser,
  markTaskNeedsWork,
  markTaskTodoFinished,
  markTaskTodoUnfinished,
  pauseTaskLane,
  reassignTaskToLane,
  reloadSession,
  removeTaskAttachment,
  removeTaskDependency,
  removeTaskFileReference,
  reportClientError,
  requestUserIntervention,
  resetTaskRuntime,
  resumeSession,
  resumeTaskLane,
  searchTaskCommentFileMentions,
  sendMailboxMessage,
  sendSessionMessage,
  setDefaultTaskFileReference,
  setSessionModel,
  stopSessionRuntime,
  stopTaskActivity,
  subscribeSession,
  compactSession,
  unsubscribeSession,
  updateTask,
  updateTaskComment,
  updateTaskSchedule,
} from "../tauri";
import type {
  OrchestraClient,
  OrchestraClientBinding,
  OrchestraTaskCompletionOutcome,
} from "./client";
import type {
  OrchestraCapabilityDescriptor,
  OrchestraClientAuthMode,
  OrchestraClientBootstrap,
  OrchestraClientCapabilities,
  OrchestraClientFeatureFlags,
  OrchestraClientHostKind,
} from "./bootstrap";
import {
  ORCHESTRA_CLIENT_CONTRACT_VERSION,
} from "./bootstrap";
import {
  toOrchestraInboxChangeDelivery,
  toOrchestraSessionChangeDelivery,
  toOrchestraSessionStreamDelivery,
  toOrchestraTaskChangeDelivery,
} from "./events";

function nowIso() {
  return new Date().toISOString();
}

function availableCapability(): OrchestraCapabilityDescriptor {
  return { availability: "available" };
}

function unavailableCapability(reason: string): OrchestraCapabilityDescriptor {
  return {
    availability: "unavailable",
    reason,
  };
}

function resolveHostKind(): OrchestraClientHostKind {
  return isTauriAvailable() ? "tauri" : "mock";
}

function resolveAuthMode(hostKind: OrchestraClientHostKind): OrchestraClientAuthMode {
  switch (hostKind) {
    case "tauri":
      return "desktop_session";
    case "remote_api":
      return "bearer_token";
    default:
      return "none";
  }
}

function resolveFeatureFlags(hostKind: OrchestraClientHostKind): OrchestraClientFeatureFlags {
  const desktopWindows = hostKind === "tauri";
  return {
    sharedCatalog: true,
    sharedTasks: true,
    sharedInbox: true,
    sharedSessions: true,
    taskSchedules: true,
    sessionStreaming: true,
    sessionControls: true,
    taskComments: true,
    taskFiles: true,
    desktopWindows,
    agentTerminal: desktopWindows,
  };
}

function resolveCapabilities(hostKind: OrchestraClientHostKind): OrchestraClientCapabilities {
  const desktopOnlyReason = "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.";
  const available = availableCapability();

  return {
    app: {
      bootstrap: available,
      errorReporting: available,
    },
    catalog: {
      projects: available,
      agents: available,
      roles: available,
      workflows: available,
    },
    tasks: {
      read: available,
      write: available,
      review: available,
      comments: available,
      todos: available,
      dependencies: available,
      attachments: available,
      fileReferences: available,
      fileContents: available,
      schedules: available,
    },
    inbox: {
      read: available,
      write: available,
      archive: available,
    },
    sessions: {
      read: available,
      write: available,
      stream: available,
      runtimeControls: available,
      modelSelection: available,
    },
    host: {
      logsWindow: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
      agentTerminal: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
      systemNotifications: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
    },
  };
}

export function createOptimisticOrchestraClientBootstrap(): OrchestraClientBootstrap {
  const hostKind = resolveHostKind();
  return {
    contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
    bootstrappedAt: nowIso(),
    hostKind,
    authMode: resolveAuthMode(hostKind),
    urls: {
      apiBaseUrl: null,
      websocketUrl: null,
    },
    featureFlags: resolveFeatureFlags(hostKind),
    capabilities: resolveCapabilities(hostKind),
    appInfo: null,
  };
}

export async function buildDefaultOrchestraClientBootstrap(): Promise<OrchestraClientBootstrap> {
  const optimistic = createOptimisticOrchestraClientBootstrap();

  try {
    return {
      ...optimistic,
      appInfo: await getAppInfo(),
      bootstrappedAt: nowIso(),
    };
  } catch {
    return optimistic;
  }
}

async function completeTask(
  taskId: string,
  outcome: OrchestraTaskCompletionOutcome,
  notes?: string,
) {
  switch (outcome) {
    case "success":
      return completeLaneAsSuccess(taskId, notes);
    case "failure":
      return completeLaneAsFailure(taskId, notes);
    case "needs_user":
      return requestUserIntervention(taskId, notes);
    default:
      return requestUserIntervention(taskId, notes);
  }
}

export function createDefaultOrchestraClient(): OrchestraClient {
  return {
    contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
    async getBootstrap() {
      return buildDefaultOrchestraClientBootstrap();
    },
    app: {
      getInfo: getAppInfo,
      reportError: reportClientError,
    },
    catalog: {
      listProjects,
      getProject,
      listAgents,
      listRoles,
      listWorkflows,
      getWorkflow,
    },
    tasks: {
      list: listTasks,
      get: getTask,
      create: createTask,
      update: updateTask,
      remove: deleteTask,
      listTodos: listTaskTodos,
      listUnfinishedTodos: listUnfinishedTaskTodos,
      addTodo: addTaskTodo,
      markTodoFinished: markTaskTodoFinished,
      markTodoUnfinished: markTaskTodoUnfinished,
      deleteTodo: deleteTaskTodo,
      listComments: listTaskComments,
      comment: commentOnTask,
      updateComment: updateTaskComment,
      deleteComment: deleteTaskComment,
      markCommentsRead: markTaskCommentsReadForUser,
      searchCommentFileMentions: searchTaskCommentFileMentions,
      listMessages: listTaskMessages,
      addDependency: addTaskDependency,
      removeDependency: removeTaskDependency,
      listFileReferences: listTaskFileReferences,
      addFileReference: addTaskFileReference,
      setDefaultFileReference: setDefaultTaskFileReference,
      removeFileReference: removeTaskFileReference,
      getFileContent: getTaskFileContent,
      addAttachment: addTaskAttachment,
      removeAttachment: removeTaskAttachment,
      listSchedules: listTaskSchedules,
      getSchedule: getTaskSchedule,
      createSchedule: createTaskSchedule,
      updateSchedule: updateTaskSchedule,
      deleteSchedule: deleteTaskSchedule,
      dispatch: dispatchTaskLane,
      complete: completeTask,
      approveReview: approveTaskReview,
      approveCompletion: approveLaneCompletion,
      markNeedsWork: markTaskNeedsWork,
      resume: resumeTaskLane,
      pause: pauseTaskLane,
      stopActivity: stopTaskActivity,
      reassign: reassignTaskToLane,
      manualWhip: manualTaskWhip,
      resetRuntime: resetTaskRuntime,
    },
    inbox: {
      list: listInboxMessages,
      send: sendMailboxMessage,
      markRead: markMailboxMessagesRead,
      archive: archiveMailboxMessages,
    },
    sessions: {
      list: listSessions,
      get: getSessionRecord,
      getRuntimeDetails: getSessionRuntimeDetails,
      getStats: getSessionStats,
      create: createSession,
      createContextual: createContextualSession,
      remove: deleteSession,
      resume: resumeSession,
      subscribe: subscribeSession,
      unsubscribe: unsubscribeSession,
      stopRuntime: stopSessionRuntime,
      getModelState: getSessionModelState,
      setModel: setSessionModel,
      compact: compactSession,
      reload: reloadSession,
      sendMessage: sendSessionMessage,
    },
    events: {
      async subscribe(handler) {
        const [stopSessionStream, stopSessionChanges, stopTaskChanges, stopInboxChanges] = await Promise.all([
          listenToSessionStream((event) => handler(toOrchestraSessionStreamDelivery(event))),
          listenToSessionChanges((event) => handler(toOrchestraSessionChangeDelivery(event))),
          listenToTaskChanges((event) => handler(toOrchestraTaskChangeDelivery(event))),
          listenToInboxChanges((event) => handler(toOrchestraInboxChangeDelivery(event))),
        ]);

        return () => {
          stopSessionStream();
          stopSessionChanges();
          stopTaskChanges();
          stopInboxChanges();
        };
      },
    },
  };
}

export function createDefaultOrchestraClientBinding(): OrchestraClientBinding {
  return {
    client: createDefaultOrchestraClient(),
    bootstrap: createOptimisticOrchestraClientBootstrap(),
  };
}
