import type { OrchestraClientBinding } from "./client";
import type { OrchestraClientBootstrap } from "./bootstrap";
import { createDefaultOrchestraClientBinding } from "./defaultClient";
import { createRemoteApiOrchestraClientBinding } from "./remoteApiClient";
import type { RemoteApiOrchestraClientOptions } from "./remoteApiTransport";
import { isTauriAvailable } from "../tauri";

export type OrchestraClientHostMode = "tauri" | "hosted_web" | "mock";

export const HOSTED_WEB_BOOTSTRAP_PATH = "/api/v1/frontend/bootstrap";

const HOST_MODE_VALUES = new Set<OrchestraClientHostMode>(["tauri", "hosted_web", "mock"]);

declare global {
  interface Window {
    __ORCHESTRA_HOST_MODE__?: OrchestraClientHostMode | string;
  }
}

function normalizeRequestedHostMode(value: unknown): OrchestraClientHostMode | null {
  if (typeof value !== "string") {
    return null;
  }

  return HOST_MODE_VALUES.has(value as OrchestraClientHostMode)
    ? value as OrchestraClientHostMode
    : null;
}

function resolveConfiguredBrowserHostMode(): OrchestraClientHostMode {
  const injected = normalizeRequestedHostMode(window.__ORCHESTRA_HOST_MODE__);
  if (injected) {
    return injected;
  }

  const envMode = normalizeRequestedHostMode(import.meta.env.VITE_ORCHESTRA_HOST_MODE);
  return envMode ?? "mock";
}

export function resolveOrchestraClientHostMode(): OrchestraClientHostMode {
  if (isTauriAvailable()) {
    return "tauri";
  }

  return resolveConfiguredBrowserHostMode();
}

export async function fetchHostedWebBootstrap(fetchImpl: typeof fetch = fetch): Promise<OrchestraClientBootstrap> {
  const response = await fetchImpl(HOSTED_WEB_BOOTSTRAP_PATH, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load Orchestra hosted-web bootstrap (${response.status} ${response.statusText}).`);
  }

  return response.json() as Promise<OrchestraClientBootstrap>;
}

export function createHostedWebBootstrapBinding(
  bootstrap: OrchestraClientBootstrap,
  options?: RemoteApiOrchestraClientOptions,
): OrchestraClientBinding {
  return createRemoteApiOrchestraClientBinding(bootstrap, options);
}

export async function resolveInitialOrchestraClientBinding(): Promise<OrchestraClientBinding> {
  const hostMode = resolveOrchestraClientHostMode();
  if (hostMode !== "hosted_web") {
    return createDefaultOrchestraClientBinding();
  }

  const bootstrap = await fetchHostedWebBootstrap();
  return createHostedWebBootstrapBinding(bootstrap);
}
