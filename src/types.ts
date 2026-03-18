export type PrimaryPage = "tasks" | "agents" | "sessions" | "settings";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionStatus = "starting" | "active" | "idle" | "paused" | "failed";
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

export interface SessionEvent {
  id: string;
  kind: SessionEventKind;
  message: string;
  timestamp: string;
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
