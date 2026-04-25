import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentOperationsDetail,
  AgentOperationsSnapshot,
  AgentQueueEntry,
  AgentQueueEntryInput,
  AgentSkillLinks,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationResult,
  AppInfo,
  ArchiveMailboxMessagesInput,
  ChannelActivityEntry,
  ChannelDetail,
  ChannelSummary,
  ChannelUpsertInput,
  LocalSkillUpsertInput,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  PiExecutableDiagnostic,
  PolicyDefinition,
  PolicySummary,
  ProjectDetail,
  ProjectSessionPromptSettings,
  ProjectSourceControlSettings,
  ProjectSummary,
  ProjectTaskAutomationSettings,
  ProjectUpsertInput,
  ProjectWorkerOverlay,
  QueuedSessionMessage,
  RepositoryRecord,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
  ResolvedPermissions,
  RoleDefinition,
  RoleOperationsDetail,
  RoleOperationsSnapshot,
  RoleQueueEntry,
  RoleQueueEntryInput,
  RoleSkillLinks,
  RoleSummary,
  RoleUpsertInput,
  RoleValidationResult,
  SendMailboxMessageInput,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionStats,
  SkillBindingInput,
  SkillDetail,
  SkillSummary,
  SkillsCatalogDiagnostics,
  SourceControlSettings,
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
  TelegramBotValidation,
  TelegramChatCandidate,
  WorkflowDefinition,
  WorkflowDeleteImpact,
  WorkflowSkillLinks,
  WorkflowSummary,
  WorkflowUpsertInput,
  WorkflowValidationResult,
} from "../../types";
import type { OrchestraClientBootstrap, OrchestraClientContractVersion } from "./bootstrap";
import type {
  OrchestraClientEvent,
  OrchestraClientEventHandler,
  OrchestraUnsubscribe,
} from "./events";
import type { OrchestraHostAdminExtension, OrchestraLocalNotificationsExtension, OrchestraShellExtension } from "./extensions";
import type { OrchestraConnectionService } from "./connection";

export type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentOperationsDetail,
  AgentOperationsSnapshot,
  AgentQueueEntry,
  AgentQueueEntryInput,
  AgentSkillLinks,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationResult,
  AppInfo,
  ArchiveMailboxMessagesInput,
  ChannelActivityEntry,
  ChannelDetail,
  ChannelSummary,
  ChannelUpsertInput,
  LocalSkillUpsertInput,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  PiExecutableDiagnostic,
  PolicyDefinition,
  PolicySummary,
  ProjectDetail,
  ProjectSessionPromptSettings,
  ProjectSourceControlSettings,
  ProjectSummary,
  ProjectTaskAutomationSettings,
  ProjectUpsertInput,
  ProjectWorkerOverlay,
  QueuedSessionMessage,
  RepositoryRecord,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
  ResolvedPermissions,
  RoleDefinition,
  RoleOperationsDetail,
  RoleOperationsSnapshot,
  RoleQueueEntry,
  RoleQueueEntryInput,
  RoleSkillLinks,
  RoleSummary,
  RoleUpsertInput,
  RoleValidationResult,
  SendMailboxMessageInput,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionStats,
  SkillBindingInput,
  SkillDetail,
  SkillSummary,
  SkillsCatalogDiagnostics,
  SourceControlSettings,
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
  TelegramBotValidation,
  TelegramChatCandidate,
  WorkflowDefinition,
  WorkflowDeleteImpact,
  WorkflowSkillLinks,
  WorkflowSummary,
  WorkflowUpsertInput,
  WorkflowValidationResult,
};

export type OrchestraTaskCompletionOutcome = "success" | "failure" | "needs_user";
export type OrchestraRoleInstanceReleaseOutcome = "success" | "failure" | "canceled";

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

export interface OrchestraProjectService {
  createProject(input: ProjectUpsertInput): Promise<ProjectDetail>;
  updateProject(projectId: string, input: ProjectUpsertInput): Promise<ProjectDetail>;
  deleteProject(projectId: string): Promise<ProjectDetail>;
  listRepositories(projectId?: string | null): Promise<RepositoryRecord[]>;
  getRepository(repositoryId: string): Promise<RepositoryRecord>;
  createRepository(projectId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord>;
  updateRepository(repositoryId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord>;
  deleteRepository(repositoryId: string): Promise<RepositoryRecord>;
  attachRepositoryRemote(repositoryId: string, input: RepositoryRemoteInput): Promise<RepositoryRecord>;
  setProjectDefaultRepository(projectId: string, repositoryId: string | null): Promise<ProjectDetail>;
}

export interface OrchestraSettingsService {
  listPiModels(): Promise<SessionModel[]>;
  getPiExecutableDiagnostic(): Promise<PiExecutableDiagnostic>;
  getSourceControlSettings(): Promise<SourceControlSettings>;
  updateSourceControlSettings(gitUserNameTemplate: string | null, gitEmailTemplate: string | null): Promise<SourceControlSettings>;
  getProjectSourceControlSettings(projectSlug?: string | null): Promise<ProjectSourceControlSettings>;
  updateProjectSourceControlSettings(
    gitUserNameTemplate: string | null,
    gitEmailTemplate: string | null,
    projectSlug?: string | null,
  ): Promise<ProjectSourceControlSettings>;
  getSessionPromptSettings(projectSlug?: string | null): Promise<ProjectSessionPromptSettings>;
  updateSessionPromptSettings(template: string | null, projectSlug?: string | null): Promise<ProjectSessionPromptSettings>;
  getTaskAutomationSettings(projectSlug?: string | null): Promise<ProjectTaskAutomationSettings>;
  updateTaskAutomationSettings(
    autoDispatchOnBlockerCompletion: boolean,
    projectSlug?: string | null,
  ): Promise<ProjectTaskAutomationSettings>;
  getWorkerOverlay(workerType: string, workerSlug: string, projectSlug?: string | null): Promise<ProjectWorkerOverlay>;
  updateWorkerOverlay(workerType: string, workerSlug: string, prompt: string, projectSlug?: string | null): Promise<ProjectWorkerOverlay>;
}

export interface OrchestraWorkerService {
  validateAgent(input: AgentUpsertInput): Promise<AgentValidationResult>;
  getAgent(agentId: string, projectId?: string | null): Promise<AgentDefinition>;
  createAgent(input: AgentUpsertInput): Promise<AgentDefinition>;
  updateAgent(agentId: string, input: AgentUpsertInput): Promise<AgentDefinition>;
  archiveAgent(agentId: string): Promise<AgentDefinition>;
  getAgentMemoryInfo(agentId: string): Promise<AgentMemoryInfo>;
  listAgentOperations(includeArchived?: boolean, projectId?: string | null): Promise<AgentOperationsSnapshot[]>;
  getAgentOperations(agentId: string, projectId?: string | null): Promise<AgentOperationsDetail>;
  ensureAgentSession(agentId: string, projectId?: string | null): Promise<SessionRecord>;
  enqueueAgentWork(input: AgentQueueEntryInput): Promise<AgentQueueEntry>;
  deleteAgentQueueEntry(queueEntryId: string): Promise<AgentQueueEntry>;
  getAgentPermissions(agentId: string): Promise<ResolvedPermissions>;
  validateRole(input: RoleUpsertInput): Promise<RoleValidationResult>;
  getRole(roleId: string): Promise<RoleDefinition>;
  createRole(input: RoleUpsertInput): Promise<RoleDefinition>;
  updateRole(roleId: string, input: RoleUpsertInput): Promise<RoleDefinition>;
  archiveRole(roleId: string): Promise<RoleDefinition>;
  listRoleOperations(includeArchived?: boolean): Promise<RoleOperationsSnapshot[]>;
  getRoleOperations(roleId: string): Promise<RoleOperationsDetail>;
  enqueueRoleWork(input: RoleQueueEntryInput): Promise<RoleQueueEntry>;
  dispatchRoleQueue(roleId: string): Promise<RoleOperationsDetail>;
  deleteRoleQueueEntry(queueEntryId: string): Promise<RoleQueueEntry>;
  resetRoleAssignments(roleId: string): Promise<RoleOperationsDetail>;
  releaseRoleInstance(
    instanceId: string,
    outcome: OrchestraRoleInstanceReleaseOutcome,
    errorMessage?: string,
  ): Promise<RoleOperationsDetail>;
  disposeRoleInstance(instanceId: string): Promise<RoleOperationsDetail>;
  getRolePermissions(roleId: string): Promise<ResolvedPermissions>;
}

export interface OrchestraWorkflowService {
  validateWorkflow(input: WorkflowUpsertInput): Promise<WorkflowValidationResult>;
  createWorkflow(input: WorkflowUpsertInput): Promise<WorkflowDefinition>;
  updateWorkflow(workflowId: string, input: WorkflowUpsertInput): Promise<WorkflowDefinition>;
  duplicateWorkflow(workflowId: string, newName?: string): Promise<WorkflowDefinition>;
  archiveWorkflow(workflowId: string): Promise<WorkflowDefinition>;
  getWorkflowDeleteImpact(workflowId: string): Promise<WorkflowDeleteImpact>;
  deleteWorkflow(workflowId: string): Promise<WorkflowDeleteImpact>;
}

export interface OrchestraPolicyService {
  listPolicies(): Promise<PolicySummary[]>;
  getPolicy(policyId: string): Promise<PolicyDefinition>;
}

export interface OrchestraChannelService {
  listChannels(): Promise<ChannelSummary[]>;
  getChannel(channelId: string): Promise<ChannelDetail>;
  listChannelActivity(channelId: string, limit?: number): Promise<ChannelActivityEntry[]>;
  createChannel(input: ChannelUpsertInput): Promise<ChannelDetail>;
  updateChannel(channelId: string, input: ChannelUpsertInput): Promise<ChannelDetail>;
  deleteChannel(channelId: string): Promise<void>;
  validateTelegramBot(botToken: string, apiBaseUrl?: string | null): Promise<TelegramBotValidation>;
  listTelegramChatCandidates(botToken: string, apiBaseUrl?: string | null): Promise<TelegramChatCandidate[]>;
}

export interface OrchestraSkillsService {
  listSkills(includeArchived?: boolean): Promise<SkillSummary[]>;
  getSkill(skillId: string): Promise<SkillDetail>;
  getCatalogDiagnostics(): Promise<SkillsCatalogDiagnostics>;
  createLocalSkill(input: LocalSkillUpsertInput): Promise<SkillDetail>;
  updateLocalSkill(skillId: string, input: LocalSkillUpsertInput): Promise<SkillDetail>;
  archiveLocalSkill(skillId: string): Promise<SkillDetail>;
  unarchiveLocalSkill(skillId: string): Promise<SkillDetail>;
  deleteLocalSkill(skillId: string): Promise<SkillDetail>;
  refreshExternalSkills(): Promise<SkillSummary[]>;
  setSkillBindings(skillId: string, bindings: SkillBindingInput[]): Promise<SkillDetail>;
  getRoleSkillLinks(roleId: string): Promise<RoleSkillLinks>;
  getAgentSkillLinks(agentId: string): Promise<AgentSkillLinks>;
  getWorkflowSkillLinks(workflowId: string): Promise<WorkflowSkillLinks>;
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
  readonly projects: OrchestraProjectService;
  readonly settings: OrchestraSettingsService;
  readonly workers: OrchestraWorkerService;
  readonly workflows: OrchestraWorkflowService;
  readonly policies: OrchestraPolicyService;
  readonly channels: OrchestraChannelService;
  readonly skills: OrchestraSkillsService;
  readonly tasks: OrchestraTaskService;
  readonly inbox: OrchestraInboxService;
  readonly sessions: OrchestraSessionService;
  readonly events: OrchestraEventService;
  readonly connection: OrchestraConnectionService;
  readonly shell?: OrchestraShellExtension;
  readonly notifications?: OrchestraLocalNotificationsExtension;
  readonly hostAdmin?: OrchestraHostAdminExtension;
}

export interface OrchestraClientBinding {
  client: OrchestraClient;
  bootstrap: OrchestraClientBootstrap;
}

export type OrchestraClientSubscription = Promise<OrchestraUnsubscribe>;
export type OrchestraDeliveredEvent = OrchestraClientEvent;
