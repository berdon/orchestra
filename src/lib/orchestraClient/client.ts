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
import type { OrchestraClientBootstrap, OrchestraClientContractVersion } from "./bootstrap";
import type {
  OrchestraClientEvent,
  OrchestraClientEventHandler,
  OrchestraUnsubscribe,
} from "./events";
import type { OrchestraHostAdminExtension, OrchestraShellExtension } from "./extensions";
import type { OrchestraConnectionService } from "./connection";

export type {
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
};

export type OrchestraTaskCompletionOutcome = "success" | "failure" | "needs_user";

export interface OrchestraAppService {
  getInfo(): Promise<AppInfo>;
  reportError(target: string, error: unknown, fallback: string): Promise<string>;
}

export interface OrchestraCatalogService {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectDetail>;
  listAgents(includeArchived?: boolean, projectId?: string | null): Promise<AgentSummary[]>;
  listRoles(includeArchived?: boolean): Promise<RoleSummary[]>;
  listWorkflows(includeArchived?: boolean): Promise<WorkflowSummary[]>;
  getWorkflow(workflowId: string): Promise<WorkflowDefinition>;
}

export interface OrchestraTaskService {
  list(options?: TaskListOptions): Promise<TaskSummary[]>;
  get(taskId: string): Promise<TaskDetail>;
  create(input: TaskUpsertInput, projectId?: string | null): Promise<TaskDetail>;
  update(taskId: string, input: TaskUpsertInput): Promise<TaskDetail>;
  remove(taskId: string): Promise<TaskDetail>;
  listTodos(taskId: string): Promise<TaskTodo[]>;
  listUnfinishedTodos(taskId: string, laneId?: string | null): Promise<TaskTodo[]>;
  addTodo(taskId: string, input: TaskTodoInput): Promise<TaskTodo>;
  markTodoFinished(todoId: string): Promise<TaskTodo>;
  markTodoUnfinished(todoId: string): Promise<TaskTodo>;
  deleteTodo(todoId: string): Promise<TaskTodo>;
  listComments(taskId: string): Promise<TaskComment[]>;
  comment(taskId: string, input: TaskCommentInput): Promise<TaskComment>;
  updateComment(commentId: string, input: TaskCommentUpdateInput): Promise<TaskComment>;
  deleteComment(commentId: string): Promise<TaskComment>;
  markCommentsRead(taskId: string): Promise<TaskDetail>;
  searchCommentFileMentions(taskId: string, query: string, limit?: number): Promise<TaskCommentFileMentionCandidate[]>;
  listMessages(taskId: string): Promise<MailboxMessage[]>;
  addDependency(blockerTaskId: string, blockedTaskId: string): Promise<TaskDependency>;
  removeDependency(dependencyId: string): Promise<TaskDependency>;
  listFileReferences(taskId: string): Promise<TaskFileReference[]>;
  addFileReference(taskId: string, input: TaskFileReferenceInput): Promise<TaskFileReference>;
  setDefaultFileReference(referenceId: string): Promise<TaskFileReference>;
  removeFileReference(referenceId: string): Promise<TaskFileReference>;
  getFileContent(path: string): Promise<string>;
  addAttachment(taskId: string, input: TaskAttachmentInput): Promise<TaskAttachment>;
  removeAttachment(attachmentId: string): Promise<TaskAttachment>;
  listSchedules(projectId?: string | null): Promise<TaskScheduleSummary[]>;
  getSchedule(scheduleId: string): Promise<TaskScheduleDetail>;
  createSchedule(input: TaskScheduleUpsertInput, projectId?: string | null): Promise<TaskScheduleDetail>;
  updateSchedule(scheduleId: string, input: TaskScheduleUpsertInput): Promise<TaskScheduleDetail>;
  deleteSchedule(scheduleId: string): Promise<TaskScheduleDetail>;
  dispatch(taskId: string): Promise<TaskDetail>;
  complete(taskId: string, outcome: OrchestraTaskCompletionOutcome, notes?: string): Promise<TaskDetail>;
  approveReview(taskId: string): Promise<TaskDetail>;
  approveCompletion(taskId: string): Promise<TaskDetail>;
  markNeedsWork(taskId: string, notes?: string): Promise<TaskDetail>;
  resume(taskId: string, notes?: string): Promise<TaskDetail>;
  pause(taskId: string, notes?: string): Promise<TaskDetail>;
  stopActivity(taskId: string, notes?: string): Promise<TaskDetail>;
  reassign(taskId: string, laneId: string, notes?: string): Promise<TaskDetail>;
  manualWhip(taskId: string): Promise<TaskDetail>;
  resetRuntime(taskId: string): Promise<TaskDetail>;
}

export interface OrchestraInboxService {
  list(projectId?: string | null, includeArchived?: boolean): Promise<MailboxMessage[]>;
  send(input: SendMailboxMessageInput): Promise<MailboxMessage>;
  markRead(input: MarkMailboxMessagesReadInput): Promise<MailboxMessage[]>;
  archive(input: ArchiveMailboxMessagesInput): Promise<MailboxMessage[]>;
}

export interface OrchestraSessionService {
  list(projectId?: string | null): Promise<SessionRecord[]>;
  get(sessionId: string): Promise<SessionRecord>;
  getRuntimeDetails(sessionId: string): Promise<SessionRuntimeDetails>;
  getStats(sessionId: string): Promise<SessionStats>;
  create(title?: string, projectSlug?: string | null): Promise<SessionRecord>;
  createContextual(sessionId: string, projectSlug?: string | null): Promise<SessionRecord>;
  remove(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<SessionRecord>;
  subscribe(sessionId: string): Promise<SessionRecord>;
  unsubscribe(sessionId: string): Promise<SessionRecord>;
  stopRuntime(sessionId: string, notes?: string): Promise<SessionRecord>;
  getModelState(sessionId: string): Promise<SessionModelState>;
  setModel(sessionId: string, provider: string, modelId: string): Promise<SessionModelState>;
  compact(sessionId: string, customInstructions?: string | null): Promise<SessionRecord>;
  reload(sessionId: string): Promise<SessionRecord>;
  sendMessage(sessionId: string, message: string, runId: string): Promise<QueuedSessionMessage>;
}

export interface OrchestraEventService {
  subscribe(handler: OrchestraClientEventHandler): Promise<OrchestraUnsubscribe>;
}

export interface OrchestraClient {
  readonly contractVersion: OrchestraClientContractVersion;
  getBootstrap(): Promise<OrchestraClientBootstrap>;
  readonly app: OrchestraAppService;
  readonly catalog: OrchestraCatalogService;
  readonly tasks: OrchestraTaskService;
  readonly inbox: OrchestraInboxService;
  readonly sessions: OrchestraSessionService;
  readonly events: OrchestraEventService;
  readonly connection: OrchestraConnectionService;
  readonly shell?: OrchestraShellExtension;
  readonly hostAdmin?: OrchestraHostAdminExtension;
}

export interface OrchestraClientBinding {
  client: OrchestraClient;
  bootstrap: OrchestraClientBootstrap;
}

export type OrchestraClientSubscription = Promise<OrchestraUnsubscribe>;
export type OrchestraDeliveredEvent = OrchestraClientEvent;
