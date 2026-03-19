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
  event: "assistantStart" | "assistantDelta" | "sessionUpdated" | "error";
  timestamp?: string;
  delta?: string;
  message?: string;
  record?: SessionRecord;
}
