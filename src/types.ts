export type PrimaryPage = "tasks" | "agents" | "sessions" | "settings";

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

export interface QueuedSessionMessage {
  sessionId: string;
  runId: string;
  message: string;
  timestamp: string;
}

export interface SessionStreamEvent {
  sessionId: string;
  runId: string;
  event: "thinking_start" | "text_start" | "text_delta" | "turn_end" | "session_updated" | "error";
  timestamp?: string;
  delta?: string;
  message?: string;
  record?: SessionRecord;
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
