export type PrimaryPage = "tasks" | "inbox" | "agents" | "chat" | "sessions" | "settings";
export type SettingsTab = "projects" | "agents" | "roles" | "workflows" | "channels" | "remote" | "general";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionStatus = "starting" | "active" | "idle" | "paused" | "failed" | "streaming" | "closed";
export type SessionEventKind = "system" | "user" | "assistant";

export interface LogEntry {
  id: string;
  level: LogLevel;
  target: string;
  message: string;
  timestamp: string;
}

export interface AppInfo {
  appName: string;
  environment: "tauri" | "browser";
  backendStatus: "connected" | "mock";
  versionDisplay: string;
  dispatchBlocked: boolean;
  dispatchBlockedReason?: string | null;
}

export type SystemNotificationPermissionState =
  | "unsupported"
  | "not_determined"
  | "denied"
  | "granted"
  | "provisional"
  | "ephemeral";

export interface SystemNotificationEnvironmentStatus {
  platform: string;
  nativeSupported: boolean;
  reason?: string | null;
  appBundlePath?: string | null;
}

export interface PiExecutableDiagnostic {
  resolvedPath?: string | null;
  error?: string | null;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  bindHost: string;
  port: number;
  baseUrl?: string | null;
  websocketUrl?: string | null;
  lanBaseUrl?: string | null;
  startedAt?: string | null;
  lastError?: string | null;
}

export interface RemoteAccessSettingsInput {
  enabled: boolean;
  bindHost?: string | null;
  port?: number | null;
}

export interface RemotePairingCode {
  id: string;
  code?: string | null;
  displayCode: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | null;
}

export interface RemotePairingCodeInput {
  label?: string | null;
  platform?: string | null;
}

export interface RemoteDeviceRecord {
  id: string;
  label: string;
  platform: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  pushTokenConfigured: boolean;
  activeClientCount: number;
}

export interface RemoteClientRecord {
  clientId: string;
  clientKind: string;
  deviceId?: string | null;
  deviceLabel?: string | null;
  activeProjectId?: string | null;
  connectedAt: string;
  lastSeenAt: string;
  subscribedSessionCount: number;
}

export interface RemoteAccessStatus {
  settings: RemoteAccessSettings;
  pairingCodes: RemotePairingCode[];
  devices: RemoteDeviceRecord[];
  activeClients: RemoteClientRecord[];
}

export interface RemoteAuthResponse {
  device: RemoteDeviceRecord;
  token: string;
  baseUrl?: string | null;
  websocketUrl?: string | null;
  defaultProjectId?: string | null;
}

export interface RemotePairingCompleteInput {
  code: string;
  label?: string | null;
  platform?: string | null;
  pushToken?: string | null;
}

export interface RemotePushTokenInput {
  pushToken?: string | null;
}

export interface RemoteEventEnvelope {
  id: string;
  sequence: number;
  topic: string;
  timestamp: string;
  projectId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  deliveryId?: string | null;
  payload: JsonValue;
}

export interface BridgeClientDiagnostics {
  clientId: string;
  sessionId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  requestCount: number;
  inFlightRequestCount: number;
  lastSeenAt: string;
  lastCommand?: string | null;
  lastError?: string | null;
  active: boolean;
  bridgeInstanceId?: string | null;
}

export interface BridgeRequestDiagnostics {
  requestId: string;
  clientId?: string | null;
  sessionId?: string | null;
  command: string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  success: boolean;
  error?: string | null;
}

export interface BridgeCleanupEvent {
  id: string;
  instanceId?: string | null;
  pid?: number | null;
  action: string;
  reason: string;
  success: boolean;
  timestamp: string;
}

export interface BridgeInstanceDiagnostics {
  instanceId: string;
  url: string;
  ownerPid: number;
  startedAt: string;
  heartbeatAt: string;
  metadataPath: string;
  activeClientCount: number;
  inFlightRequestCount: number;
}

export interface BridgeDiagnostics {
  instance: BridgeInstanceDiagnostics;
  clients: BridgeClientDiagnostics[];
  recentRequests: BridgeRequestDiagnostics[];
  recentCleanupEvents: BridgeCleanupEvent[];
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  defaultRepositoryId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryRecord {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  repositoryPath?: string | null;
  sourcePath?: string | null;
  sourceKind?: "local" | "remote" | null;
  mode?: "existing" | "local_new" | null;
  defaultBranch?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  repositories: RepositoryRecord[];
}

export interface ProjectUpsertInput {
  name: string;
  description?: string | null;
}

export interface RepositoryUpsertInput {
  name: string;
  mode?: "existing" | "local_new" | null;
  repositoryPath?: string | null;
  defaultBranch?: string | null;
}

export interface RepositoryRemoteInput {
  remoteUrl: string;
  remoteName?: string | null;
}

export interface SessionModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
}

export interface SessionModelState {
  sessionId: string;
  currentModel: SessionModel | null;
  currentThinkingLevel: string;
  availableModels: SessionModel[];
}

export interface SessionEvent {
  id: string;
  kind: SessionEventKind;
  message: string;
  timestamp: string;
  pending?: boolean;
  thinking?: boolean;
  thinkingText?: string;
  runId?: string;
  label?: string;
  presentation?: "default" | "tool_call";
}

export type SessionActivityState = "idle" | "thinking" | "streaming" | "tool_running" | "error";

export interface SessionDebugInfo {
  projectRoot?: string | null;
  managedRepositoryPath?: string | null;
  worktreePath?: string | null;
  sessionCwd?: string | null;
}

export interface SessionRuntimeDetails {
  sessionId: string;
  source: string;
  runtimeActive: boolean;
  subscribed: boolean;
  extensionLoadMode: string;
  automaticExtensionsDisabled: boolean;
  orchestraExtensionPath?: string | null;
  extraExtensions: string[];
  loadedExtensions: string[];
  piExecutablePath?: string | null;
  shellPath?: string | null;
  projectRoot?: string | null;
  sessionDir?: string | null;
  sessionPath?: string | null;
  notes: string[];
}

export interface SessionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionContextUsage {
  tokens?: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface SessionStats {
  sessionId: string;
  sessionFile?: string | null;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: SessionTokenUsage;
  cost: number;
  contextUsage?: SessionContextUsage | null;
}

export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  subscribed: boolean;
  events: SessionEvent[];
  terminalAttached?: boolean;
  activityState?: SessionActivityState;
  activeToolName?: string | null;
  lastActivityAt?: string | null;
  debugInfo?: SessionDebugInfo | null;
  taskId?: string | null;
  taskNumber?: string | null;
  taskTitle?: string | null;
  workerType?: string | null;
  workerName?: string | null;
}

export interface SessionScrollState {
  lockedToBottom: boolean;
}

export type AgentScope = "global" | "project";

export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  roleId?: string | null;
  scope: AgentScope;
  projectId?: string | null;
  thinkingLevel: string;
  policyIds?: string[];
  directPermissions?: string[];
  system?: boolean;
  immutable?: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  roleId?: string | null;
  scope: AgentScope;
  projectId?: string | null;
  thinkingLevel: string;
  policyIds?: string[];
  directPermissions?: string[];
  system?: boolean;
  immutable?: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentUpsertInput {
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  roleId?: string | null;
  scope?: AgentScope | null;
  projectId?: string | null;
  thinkingLevel?: string | null;
  policyIds?: string[];
  directPermissions?: string[];
}

export interface AgentValidationError {
  code: string;
  path: string;
  message: string;
}

export interface AgentValidationResult {
  valid: boolean;
  errors: AgentValidationError[];
}

export interface AgentMemoryInfo {
  agentId: string;
  slug: string;
  rootDir: string;
  agentsPath: string;
  identityPath: string;
  soulPath: string;
  memoryPath: string;
  toolsPath: string;
  dailyMemoryDir: string;
}

export interface AgentRuntimeState {
  projectId: string;
  agentId: string;
  status: string;
  mainSessionId?: string | null;
  runtimeCwd?: string | null;
  currentQueueEntryId?: string | null;
  lastDispatchAt?: string | null;
  lastError?: string | null;
  terminalAttached?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentQueueEntry {
  id: string;
  projectId: string;
  agentId: string;
  status: string;
  sourceType: string;
  sourceTaskId?: string | null;
  sourceWorkflowId?: string | null;
  sourceLaneId?: string | null;
  deliveryMode: string;
  title: string;
  message: string;
  sessionId?: string | null;
  runId?: string | null;
  dispatchedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentQueueEntryInput {
  agentId: string;
  sourceType: string;
  sourceTaskId?: string | null;
  sourceWorkflowId?: string | null;
  sourceLaneId?: string | null;
  deliveryMode: "prompt" | "follow_up" | "steer" | string;
  title: string;
  message: string;
}

export interface AgentOperationsSnapshot {
  agent: AgentDefinition;
  runtimeState: AgentRuntimeState;
  queuedCount: number;
  dispatchedCount: number;
}

export interface AgentOperationsDetail {
  agent: AgentDefinition;
  runtimeState: AgentRuntimeState;
  queueEntries: AgentQueueEntry[];
}

export interface ProjectWorkerOverlay {
  projectSlug: string;
  workerType: string;
  workerSlug: string;
  prompt?: string | null;
  updatedAt?: string | null;
}

export interface SessionPromptToken {
  token: string;
  description: string;
}

export interface ProjectSessionPromptSettings {
  projectSlug: string;
  template: string;
  defaultTemplate: string;
  availableTokens: SessionPromptToken[];
  updatedAt?: string | null;
}

export interface ProjectTaskAutomationSettings {
  projectSlug: string;
  autoDispatchOnBlockerCompletion: boolean;
  updatedAt?: string | null;
}

export interface PiRuntimeSettings {
  extraExtensions: string[];
  updatedAt?: string | null;
}

export interface TelegramChannelConfig {
  botUsername?: string | null;
  apiBaseUrl?: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
  chatType?: string | null;
  commandsEnabled: boolean;
}

export interface TelegramChannelConfigInput {
  botToken?: string | null;
  apiBaseUrl?: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
  chatType?: string | null;
  commandsEnabled: boolean;
}

export interface ChannelUpsertInput {
  kind?: string | null;
  name?: string | null;
  enabled?: boolean | null;
  targetAgentId?: string | null;
  defaultProjectId?: string | null;
  telegram?: TelegramChannelConfigInput | null;
}

export interface ChannelSummary {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  status: string;
  targetAgentId: string;
  defaultProjectId?: string | null;
  defaultProjectName?: string | null;
  lastError?: string | null;
  lastActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDetail extends ChannelSummary {
  secretConfigured: boolean;
  telegram?: TelegramChannelConfig | null;
}

export interface ChannelActivityEntry {
  id: string;
  channelId: string;
  direction: string;
  messageKind: string;
  externalMessageId?: string | null;
  chatId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  body: string;
  status: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramBotValidation {
  botId: string;
  username: string;
  displayName: string;
}

export interface TelegramChatCandidate {
  chatId: string;
  title: string;
  chatType: string;
  username?: string | null;
  lastMessageText?: string | null;
  lastMessageAt?: string | null;
}

export interface PolicyDefinition {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  permissions: string[];
  system: boolean;
  immutable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PolicySummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  system: boolean;
  immutable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorizationContext {
  actorType: string;
  actorId: string;
}

export interface ResolvedPermissions {
  actorType: string;
  actorId: string;
  inheritedRoleId?: string | null;
  policyIds: string[];
  permissions: string[];
  grantsFullAccess: boolean;
}

export interface OrchestraToolDefinition {
  name: string;
  description: string;
  requiredPermission: string;
}

export interface QueuedSessionMessage {
  sessionId: string;
  runId: string;
  message: string;
  timestamp: string;
}

export interface SessionStreamEnvelope {
  sessionId: string;
  runId?: string | null;
  event: JsonValue;
  receivedAt: string;
}

export interface SessionChangeEvent {
  sessionIds: string[];
  reason: string;
}

export interface TaskChangeEvent {
  taskIds: string[];
  reason: string;
}

export interface InboxChangeEvent {
  deliveryIds: string[];
  reason: string;
}

export type WorkflowOwnerType = "user" | "agent" | "role";
export type WorkflowTransitionType = "lane" | "user_intervention" | "end";

export interface WorkflowLane {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  order: number;
  assignedEntityType: WorkflowOwnerType | string;
  assignedEntityId?: string | null;
  entryPromptTemplate?: string | null;
  useSeparateWorktree?: boolean;
  requireUserApprovalOnSuccess?: boolean;
  successTransitionType: WorkflowTransitionType | string;
  successTargetLaneId?: string | null;
  failureTransitionType: WorkflowTransitionType | string;
  failureTargetLaneId?: string | null;
}

export interface RoleDefinition {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  thinkingLevel: string;
  capacity: number;
  policyIds?: string[];
  directPermissions?: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  provider?: string | null;
  model?: string | null;
  thinkingLevel: string;
  capacity: number;
  policyIds?: string[];
  directPermissions?: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleUpsertInput {
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  capacity: number;
  policyIds?: string[];
  directPermissions?: string[];
}

export interface RoleValidationError {
  code: string;
  path: string;
  message: string;
}

export interface RoleValidationResult {
  valid: boolean;
  errors: RoleValidationError[];
}

export interface RoleQueueEntry {
  id: string;
  roleId: string;
  status: string;
  sourceType: string;
  sourceTaskId?: string | null;
  sourceWorkflowId?: string | null;
  sourceLaneId?: string | null;
  title: string;
  summary?: string | null;
  entryPrompt?: string | null;
  assignedInstanceId?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface RoleQueueEntryInput {
  roleId: string;
  sourceType: string;
  sourceTaskId?: string | null;
  sourceWorkflowId?: string | null;
  sourceLaneId?: string | null;
  title: string;
  summary?: string | null;
  entryPrompt?: string | null;
}

export interface RoleInstance {
  id: string;
  roleId: string;
  displayName: string;
  status: string;
  currentQueueEntryId?: string | null;
  sessionId?: string | null;
  worktreePath?: string | null;
  lastHeartbeatAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleInstanceInput {
  roleId: string;
  displayName?: string | null;
  status?: string | null;
  currentQueueEntryId?: string | null;
  sessionId?: string | null;
  worktreePath?: string | null;
  lastHeartbeatAt?: string | null;
  lastError?: string | null;
}

export interface RoleOperationsSnapshot {
  role: RoleSummary;
  queuedCount: number;
  assignedCount: number;
  activeInstanceCount: number;
  idleInstanceCount: number;
  latestError?: string | null;
}

export interface RoleOperationsDetail {
  role: RoleDefinition;
  queuedCount: number;
  assignedCount: number;
  activeInstanceCount: number;
  idleInstanceCount: number;
  queueEntries: RoleQueueEntry[];
  instances: RoleInstance[];
}

export type TaskType = "task" | "bug" | "feature" | "chore" | "epic";
export type TaskStatus = "draft" | "ready" | "in_progress" | "blocked" | "in_review" | "completed" | "canceled";
export type TaskPriority = "P0" | "P1" | "P2" | "P3" | "P4";
export type TaskAssigneeType = "user" | "agent" | "role" | "unassigned";

export interface TaskComment {
  id: string;
  taskId: string;
  parentCommentId?: string | null;
  author: string;
  originType: string;
  originId?: string | null;
  message: string;
  interruptAgent: boolean;
  repositoryId?: string | null;
  relativePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  columnStart?: number | null;
  columnEnd?: number | null;
  selectedText?: string | null;
  anchorCommitHash?: string | null;
  anchorHasUncommittedChanges?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCommentInput {
  author: string;
  originType?: string | null;
  originId?: string | null;
  message: string;
  interruptAgent: boolean;
  parentCommentId?: string | null;
  repositoryId?: string | null;
  relativePath?: string | null;
  absolutePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  columnStart?: number | null;
  columnEnd?: number | null;
  selectedText?: string | null;
}

export interface TaskCommentUpdateInput {
  message: string;
}

export interface TaskTodo {
  id: string;
  taskId: string;
  laneId: string;
  description: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTodoInput {
  laneId?: string | null;
  description: string;
}

export interface TaskCommentFileMentionCandidate {
  repositoryId: string;
  repositoryName: string;
  repositorySlug: string;
  relativePath: string;
  displayText: string;
  insertText: string;
}

export type MailboxRecipientType = "user" | "agent" | "active_assignment" | "assignment";
export type MailboxPriority = "normal" | "interrupt";

export interface SendMailboxMessageInput {
  projectId?: string | null;
  taskId?: string | null;
  recipientType: MailboxRecipientType | string;
  recipientId?: string | null;
  senderLabel?: string | null;
  body: string;
  priority?: MailboxPriority | string | null;
}

export interface MarkMailboxMessagesReadInput {
  deliveryIds?: string[] | null;
}

export interface ArchiveMailboxMessagesInput {
  deliveryIds?: string[] | null;
}

export interface MailboxMessage {
  deliveryId: string;
  messageId: string;
  projectId: string;
  taskId?: string | null;
  taskNumber?: string | null;
  taskTitle?: string | null;
  senderType: string;
  senderId?: string | null;
  senderLabel: string;
  recipientType: string;
  recipientId?: string | null;
  recipientLabel: string;
  assignmentId?: string | null;
  body: string;
  priority: MailboxPriority | string;
  readAt?: string | null;
  readSessionId?: string | null;
  archivedAt?: string | null;
  lastNotifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  id: string;
  blockerTaskId: string;
  blockedTaskId: string;
  blocker: TaskSummary;
  blocked: TaskSummary;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  storedPath: string;
  caption?: string | null;
  previewText?: string | null;
  imageDataUrl?: string | null;
  createdAt: string;
}

export interface TaskAttachmentInput {
  fileName: string;
  mediaType: string;
  base64Data: string;
  caption?: string | null;
}

export interface TaskFileReference {
  id: string;
  taskId: string;
  repositoryId: string;
  repositoryName: string;
  repositorySlug: string;
  relativePath: string;
  absolutePath?: string | null;
  exists: boolean;
  isDefault: boolean;
  createdAt: string;
}

export interface TaskFileReferenceInput {
  repositoryId: string;
  relativePath: string;
}

export interface TaskRepository {
  taskId: string;
  repositoryId: string;
  repositoryName: string;
  repositorySlug: string;
  managedRepositoryPath?: string | null;
  sourcePath?: string | null;
  sourceKind?: "local" | "remote" | null;
  taskWorktreePath?: string | null;
  createdAt: string;
}

export interface TaskLaneRun {
  id: string;
  taskId: string;
  laneId: string;
  sessionId: string;
  result: "success" | "failure" | "needs_user" | "canceled";
  notes?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface TaskLaneAssignment {
  id: string;
  taskId: string;
  workflowId: string;
  laneId: string;
  workerType: string;
  workerId?: string | null;
  status: string;
  sessionId?: string | null;
  runtimeCwd?: string | null;
  roleQueueEntryId?: string | null;
  roleInstanceId?: string | null;
  prompt?: string | null;
  pendingOutcome?: string | null;
  completionNotes?: string | null;
  whipCount?: number;
  lastWhipAt?: string | null;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  number: string;
  title: string;
  description?: string | null;
  type: TaskType | string;
  status: TaskStatus | string;
  priority: TaskPriority | string;
  workflowId?: string | null;
  currentLaneId?: string | null;
  assigneeType: TaskAssigneeType | string;
  assigneeId?: string | null;
  parentTaskId?: string | null;
  whipMaxAttempts?: number;
  archived: boolean;
  commentCount: number;
  unreadCommentCount: number;
  laneRunCount: number;
  childCount: number;
  completedChildCount: number;
  inProgressChildCount: number;
  blockedChildCount: number;
  blockedByCount: number;
  blockingCount: number;
  attachmentCount: number;
  dependencyBlocked: boolean;
  readyForDispatch: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  repositoryId?: string | null;
  repositoryIds: string[];
  whipMaxAttempts?: number;
  parent?: TaskSummary | null;
  lineage: TaskSummary[];
  children: TaskSummary[];
  blockedBy: TaskDependency[];
  blocking: TaskDependency[];
  attachments: TaskAttachment[];
  taskRepositories: TaskRepository[];
  fileReferences: TaskFileReference[];
  comments: TaskComment[];
  todos: TaskTodo[];
  laneRuns: TaskLaneRun[];
  activeLaneAssignment?: TaskLaneAssignment | null;
}

export interface TaskUpsertInput {
  title: string;
  description?: string | null;
  type: TaskType | string;
  status: TaskStatus | string;
  priority: TaskPriority | string;
  workflowId?: string | null;
  currentLaneId?: string | null;
  assigneeType: TaskAssigneeType | string;
  assigneeId?: string | null;
  repositoryId?: string | null;
  repositoryIds?: string[];
  parentTaskId?: string | null;
  whipMaxAttempts?: number | null;
  archived?: boolean;
}

export type DomainEventTopic =
  | "task.created"
  | "task.updated"
  | "task.deleted"
  | "task.comment_added"
  | "task.comment_updated"
  | "task.comment_deleted"
  | "task.file_reference_added"
  | "task.file_reference_removed"
  | "task.attachment_added"
  | "task.attachment_removed"
  | "task.dispatched"
  | "task.completed"
  | "task.transition_success"
  | "task.failed"
  | "task.relaned"
  | "task.user_intervention_requested"
  | "session.created"
  | "session.resumed"
  | "session.closed"
  | "session.dismissed"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "repository.created"
  | "repository.updated"
  | "repository.deleted"
  | "agent.created"
  | "agent.updated"
  | "agent.archived"
  | "role.created"
  | "role.updated"
  | "role.archived"
  | "workflow.created"
  | "workflow.updated"
  | "workflow.archived"
  | "task.schedule.created"
  | "task.schedule.updated"
  | "task.schedule.deleted";

export interface DomainEvent {
  sequence: number;
  id: string;
  projectId?: string | null;
  topic: DomainEventTopic | string;
  entityType: string;
  entityId?: string | null;
  payload: JsonValue;
  createdAt: string;
}

export type TaskScheduleOverlapPolicy = "skip" | "create_another";
export type TaskScheduleOccurrenceStatus = "pending" | "materialized" | "skipped" | "failed";
export type TaskScheduleDayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type TaskScheduleTimeTrigger =
  | {
      kind: "once";
      at: string;
      timezone: string;
    }
  | {
      kind: "everyMinutes";
      everyMinutes: number;
    }
  | {
      kind: "daily";
      timeOfDay: string;
      timezone: string;
    }
  | {
      kind: "weekly";
      timeOfDay: string;
      timezone: string;
      daysOfWeek: TaskScheduleDayOfWeek[];
    }
  | {
      kind: "monthly";
      timeOfDay: string;
      timezone: string;
      dayOfMonth: number;
    };

export interface TaskScheduleEventTrigger {
  eventKey: DomainEventTopic | string;
}

export type TaskScheduleTrigger =
  | ({
      type: "time";
    } & TaskScheduleTimeTrigger)
  | ({
      type: "event";
    } & TaskScheduleEventTrigger);

export interface TaskScheduleOccurrence {
  id: string;
  scheduleId: string;
  occurrenceKey: string;
  scheduledAt?: string | null;
  eventId?: string | null;
  status: TaskScheduleOccurrenceStatus | string;
  taskId?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskScheduleUpsertInput {
  task: TaskUpsertInput;
  enabled?: boolean | null;
  oneShot: boolean;
  overlapPolicy: TaskScheduleOverlapPolicy | string;
  trigger: TaskScheduleTrigger;
}

export interface TaskScheduleSummary {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  type: TaskType | string;
  priority: TaskPriority | string;
  workflowId?: string | null;
  repositoryIds: string[];
  enabled: boolean;
  oneShot: boolean;
  overlapPolicy: TaskScheduleOverlapPolicy | string;
  trigger: TaskScheduleTrigger;
  nextFireAt?: string | null;
  lastFiredAt?: string | null;
  lastMaterializedTaskId?: string | null;
  lastError?: string | null;
  materializedTaskCount: number;
  openMaterializedTaskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskScheduleDetail extends TaskScheduleSummary {
  taskBlueprint: TaskUpsertInput;
  recentMaterializedTasks: TaskSummary[];
  recentOccurrences: TaskScheduleOccurrence[];
}

export interface WorkflowDefinition {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  archived: boolean;
  lanes: WorkflowLane[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  archived: boolean;
  laneCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowLaneInput {
  id?: string;
  key: string;
  name: string;
  description?: string | null;
  order?: number;
  assignedEntityType: WorkflowOwnerType | string;
  assignedEntityId?: string | null;
  entryPromptTemplate?: string | null;
  useSeparateWorktree?: boolean;
  requireUserApprovalOnSuccess?: boolean;
  successTransitionType: WorkflowTransitionType | string;
  successTargetLaneId?: string | null;
  failureTransitionType: WorkflowTransitionType | string;
  failureTargetLaneId?: string | null;
}

export interface WorkflowUpsertInput {
  name: string;
  description?: string | null;
  lanes: WorkflowLaneInput[];
}

export interface WorkflowValidationError {
  code: string;
  path: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowValidationError[];
}
