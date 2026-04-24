export type OrchestraBrowserHostMode = "tauri" | "hosted_web" | "mock";

const HOST_MODE_VALUES = new Set<OrchestraBrowserHostMode>(["tauri", "hosted_web", "mock"]);

declare global {
  interface Window {
    __ORCHESTRA_HOST_MODE__?: OrchestraBrowserHostMode | string;
  }
}

function normalizeHostMode(value: unknown): OrchestraBrowserHostMode | null {
  if (typeof value !== "string") {
    return null;
  }

  return HOST_MODE_VALUES.has(value as OrchestraBrowserHostMode)
    ? value as OrchestraBrowserHostMode
    : null;
}

export function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function resolveConfiguredBrowserHostMode(): OrchestraBrowserHostMode {
  if (isTauriAvailable()) {
    return "tauri";
  }

  const injected = normalizeHostMode(window.__ORCHESTRA_HOST_MODE__);
  if (injected) {
    return injected;
  }

  const envMode = normalizeHostMode(import.meta.env.VITE_ORCHESTRA_HOST_MODE);
  return envMode ?? "mock";
}

export function isHostedWebBrowserMode() {
  return resolveConfiguredBrowserHostMode() === "hosted_web";
}
