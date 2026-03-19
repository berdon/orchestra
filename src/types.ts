export type PrimaryPage = "tasks" | "agents" | "sessions" | "settings";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionStatus = "starting" | "active" | "idle" | "paused" | "failed" | "streaming";
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
  runId?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  subscribed: boolean;
  events: SessionEvent[];
}

export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  thinkingLevel: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
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
