import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, LogEntry } from "../types";

const mockLogs: LogEntry[] = [
  {
    id: "log-1",
    level: "info",
    target: "app.bootstrap",
    message: "Frontend scaffold initialized",
    timestamp: new Date().toISOString(),
  },
  {
    id: "log-2",
    level: "info",
    target: "settings.logs",
    message: "Using browser fallback until Tauri backend is running",
    timestamp: new Date().toISOString(),
  },
];

function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauriAvailable()) {
    return {
      appName: "Orchestra",
      environment: "browser",
      backendStatus: "mock",
    };
  }

  return invoke<AppInfo>("get_app_info");
}

export async function getLogs(): Promise<LogEntry[]> {
  if (!isTauriAvailable()) {
    return mockLogs;
  }

  return invoke<LogEntry[]>("get_logs");
}
