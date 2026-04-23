import type {
  OrchestraCatalogService,
  OrchestraClient,
  OrchestraClientBinding,
  OrchestraEventService,
  OrchestraInboxService,
  OrchestraSessionService,
  OrchestraTaskService,
} from "./client";
import type { AppInfo } from "../../types";
import type { OrchestraClientBootstrap } from "./bootstrap";
import { createDefaultOrchestraClientBinding } from "./defaultClient";
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

function resolveHostedWebAppInfoUrl(bootstrap: OrchestraClientBootstrap) {
  return bootstrap.urls.apiBaseUrl
    ? new URL("/api/v1/app-info", bootstrap.urls.apiBaseUrl).toString()
    : "/api/v1/app-info";
}

async function fetchHostedWebAppInfo(
  bootstrap: OrchestraClientBootstrap,
  fetchImpl: typeof fetch = fetch,
): Promise<AppInfo> {
  const response = await fetchImpl(resolveHostedWebAppInfoUrl(bootstrap), {
    credentials: bootstrap.authMode === "same_origin_cookie" ? "same-origin" : "omit",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load Orchestra app info (${response.status} ${response.statusText}).`);
  }

  return response.json() as Promise<AppInfo>;
}

function createHostedWebClientUnavailableError(operation: string) {
  return new Error(
    `Hosted-web bootstrap resolved successfully, but the shared remote OrchestraClient transport for ${operation} is not implemented yet. ORC-61 will attach the real remote adapter to this binding seam.`,
  );
}

function createUnsupportedServiceProxy<T extends object>(serviceName: string): T {
  return new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw createHostedWebClientUnavailableError(`${serviceName}.${String(property)}`);
      };
    },
  }) as T;
}

export function createHostedWebBootstrapBinding(
  bootstrap: OrchestraClientBootstrap,
  fetchImpl: typeof fetch = fetch,
): OrchestraClientBinding {
  const client: OrchestraClient = {
    contractVersion: bootstrap.contractVersion,
    async getBootstrap() {
      return bootstrap;
    },
    app: {
      async getInfo() {
        if (bootstrap.appInfo) {
          return bootstrap.appInfo;
        }
        return fetchHostedWebAppInfo(bootstrap, fetchImpl);
      },
      async reportError(_target, error, fallback) {
        console.error("[orchestra-client.hosted-web]", error);
        return fallback;
      },
    },
    catalog: createUnsupportedServiceProxy<OrchestraCatalogService>("catalog"),
    tasks: createUnsupportedServiceProxy<OrchestraTaskService>("tasks"),
    inbox: createUnsupportedServiceProxy<OrchestraInboxService>("inbox"),
    sessions: createUnsupportedServiceProxy<OrchestraSessionService>("sessions"),
    events: createUnsupportedServiceProxy<OrchestraEventService>("events"),
  };

  return {
    client,
    bootstrap,
  };
}

export async function resolveInitialOrchestraClientBinding(): Promise<OrchestraClientBinding> {
  const hostMode = resolveOrchestraClientHostMode();
  if (hostMode !== "hosted_web") {
    return createDefaultOrchestraClientBinding();
  }

  const bootstrap = await fetchHostedWebBootstrap();
  return createHostedWebBootstrapBinding(bootstrap);
}
