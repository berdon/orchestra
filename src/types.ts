export type PrimaryPage = "tasks" | "agents" | "sessions" | "settings";

export interface LogEntry {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  target: string;
  message: string;
  timestamp: string;
}

export interface AppInfo {
  appName: string;
  environment: "tauri" | "browser";
  backendStatus: "connected" | "mock";
}
