import type {
  AppInfo,
  JsonValue,
  TaskListOptions,
} from "../../types";
import {
  ORCHESTRA_CLIENT_CONTRACT_VERSION,
  type OrchestraCapabilityDescriptor,
  type OrchestraClientBootstrap,
} from "./bootstrap";
import type { OrchestraConnectionController } from "./connection";
import {
  OrchestraClientError,
  normalizeOrchestraClientError,
} from "./errors";

export interface RemoteApiOrchestraClientOptions {
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  getBearerToken?: () => string | null | undefined;
}

type RemoteApiResponseParser = "json" | "text" | "none";
type RemoteApiQueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

interface RemoteApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, RemoteApiQueryValue>;
  body?: unknown;
  parseAs?: RemoteApiResponseParser;
  allowAnonymous?: boolean;
}

interface ParsedRemoteApiErrorBody {
  message: string;
  details: JsonValue | null;
}

export interface RemoteApiTransport {
  readonly bootstrap: OrchestraClientBootstrap;
  assertCapability(
    operation: string,
    descriptor: OrchestraCapabilityDescriptor,
    details?: JsonValue | null,
  ): void;
  assertRemoteBootstrap(operation: string): void;
  getWebSocketUrl(operation: string): string;
  requestJson<T>(operation: string, options: RemoteApiRequestOptions): Promise<T>;
  requestText(operation: string, options: RemoteApiRequestOptions): Promise<string>;
  requestVoid(operation: string, options: RemoteApiRequestOptions): Promise<void>;
}

function createBootstrapDetails(bootstrap: OrchestraClientBootstrap, details?: JsonValue | null): JsonValue {
  return {
    hostKind: bootstrap.hostKind,
    authMode: bootstrap.authMode,
    contractVersion: bootstrap.contractVersion,
    urls: {
      apiBaseUrl: bootstrap.urls.apiBaseUrl,
      websocketUrl: bootstrap.urls.websocketUrl,
    },
    details: details ?? null,
  } satisfies JsonValue;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function parseRemoteApiErrorText(rawText: string, fallback: string): ParsedRemoteApiErrorBody {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      message: fallback,
      details: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : fallback;
      return {
        message,
        details: parsed,
      };
    }
    return {
      message: typeof parsed === "string" ? parsed : fallback,
      details: parsed,
    };
  } catch {
    return {
      message: trimmed || fallback,
      details: rawText,
    };
  }
}

function buildQueryString(query?: Record<string, RemoteApiQueryValue>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        searchParams.set(key, value.join(","));
      }
      continue;
    }
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

function normalizeTaskListQuery(options?: TaskListOptions): Record<string, RemoteApiQueryValue> {
  return {
    projectId: options?.projectId,
    includeArchived: options?.includeArchived ?? false,
    tags: options?.tags,
    tagMatch: options?.tagMatch ?? "all",
    sortBy: options?.sortBy ?? "updatedAt",
    sortDirection: options?.sortDirection ?? "desc",
  };
}

function resolveFetchImpl(options?: RemoteApiOrchestraClientOptions) {
  return options?.fetchImpl ?? fetch;
}

export function getRemoteApiAuthToken(
  bootstrap: OrchestraClientBootstrap,
  options?: RemoteApiOrchestraClientOptions,
): string | null {
  if (bootstrap.authMode !== "bearer_token") {
    return null;
  }

  const token = options?.getBearerToken?.();
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

export function resolveRemoteApiWebSocketUrl(
  bootstrap: OrchestraClientBootstrap,
  options?: RemoteApiOrchestraClientOptions,
): string | null {
  if (!bootstrap.urls.websocketUrl) {
    return null;
  }

  const url = new URL(bootstrap.urls.websocketUrl);
  const token = getRemoteApiAuthToken(bootstrap, options);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function validateRemoteApiBootstrap(
  bootstrap: OrchestraClientBootstrap,
  operation = "remoteApi.createClient",
): void {
  if (bootstrap.hostKind !== "remote_api") {
    throw normalizeOrchestraClientError(
      `Hosted-web remote adapter requires hostKind \"remote_api\", but received \"${bootstrap.hostKind}\".`,
      {
        operation,
        source: "adapter",
        fallbackMessage: "Remote OrchestraClient bootstrap is not compatible with the remote API adapter.",
        code: "unsupported",
        retryable: false,
        details: createBootstrapDetails(bootstrap),
      },
    );
  }

  if (bootstrap.contractVersion !== ORCHESTRA_CLIENT_CONTRACT_VERSION) {
    throw normalizeOrchestraClientError(
      `Remote OrchestraClient contract mismatch. Expected ${ORCHESTRA_CLIENT_CONTRACT_VERSION} but received ${bootstrap.contractVersion}.`,
      {
        operation,
        source: "adapter",
        fallbackMessage: "Remote OrchestraClient contract version is not supported by this frontend.",
        code: "unsupported",
        retryable: false,
        details: createBootstrapDetails(bootstrap),
      },
    );
  }
}

export function createRemoteApiTransport(
  bootstrap: OrchestraClientBootstrap,
  clientOptions?: RemoteApiOrchestraClientOptions,
  connectionController?: OrchestraConnectionController,
): RemoteApiTransport {
  validateRemoteApiBootstrap(bootstrap);
  const fetchImpl = resolveFetchImpl(clientOptions);

  function assertRemoteBootstrap(operation: string) {
    validateRemoteApiBootstrap(bootstrap, operation);
  }

  function assertCapability(
    operation: string,
    descriptor: OrchestraCapabilityDescriptor,
    details?: JsonValue | null,
  ) {
    assertRemoteBootstrap(operation);
    if (descriptor.availability === "available") {
      return;
    }

    throw normalizeOrchestraClientError(
      descriptor.reason ?? `The remote API adapter does not support ${operation}.`,
      {
        operation,
        source: "adapter",
        fallbackMessage: `The remote API adapter does not support ${operation}.`,
        code: "unsupported",
        retryable: false,
        details: createBootstrapDetails(bootstrap, {
          capability: {
            availability: descriptor.availability,
            reason: descriptor.reason ?? null,
          },
          details: details ?? null,
        }),
      },
    );
  }

  function getApiBaseUrl(operation: string) {
    assertRemoteBootstrap(operation);
    if (!bootstrap.urls.apiBaseUrl) {
      throw normalizeOrchestraClientError(
        `Remote API base URL is unavailable for ${operation}.`,
        {
          operation,
          source: "adapter",
          fallbackMessage: `Remote API base URL is unavailable for ${operation}.`,
          code: "unsupported",
          retryable: false,
          details: createBootstrapDetails(bootstrap),
        },
      );
    }

    return bootstrap.urls.apiBaseUrl;
  }

  function getWebSocketUrl(operation: string) {
    assertRemoteBootstrap(operation);
    const resolved = resolveRemoteApiWebSocketUrl(bootstrap, clientOptions);
    if (!resolved) {
      throw normalizeOrchestraClientError(
        `Remote WebSocket URL is unavailable for ${operation}.`,
        {
          operation,
          source: "adapter",
          fallbackMessage: `Remote WebSocket URL is unavailable for ${operation}.`,
          code: "unsupported",
          retryable: false,
          details: createBootstrapDetails(bootstrap),
        },
      );
    }

    if (bootstrap.authMode === "bearer_token" && !getRemoteApiAuthToken(bootstrap, clientOptions)) {
      throw normalizeOrchestraClientError(
        `Remote bearer token is required for ${operation}.`,
        {
          operation,
          source: "adapter",
          fallbackMessage: `Remote bearer token is required for ${operation}.`,
          code: "unauthorized",
          retryable: false,
          details: createBootstrapDetails(bootstrap),
        },
      );
    }

    return resolved;
  }

  async function request<T>(operation: string, options: RemoteApiRequestOptions): Promise<T> {
    assertRemoteBootstrap(operation);

    if (!options.allowAnonymous && bootstrap.authMode === "none") {
      throw normalizeOrchestraClientError(
        `Remote authentication is required for ${operation}.`,
        {
          operation,
          source: "remote_api",
          fallbackMessage: `Remote authentication is required for ${operation}.`,
          code: "unauthorized",
          retryable: false,
          details: createBootstrapDetails(bootstrap),
        },
      );
    }

    const url = new URL(`${options.path}${buildQueryString(options.query)}`, getApiBaseUrl(operation)).toString();
    const headers = new Headers({
      Accept: "application/json",
    });
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };

    switch (bootstrap.authMode) {
      case "same_origin_cookie":
        init.credentials = "same-origin";
        break;
      case "bearer_token": {
        const token = getRemoteApiAuthToken(bootstrap, clientOptions);
        if (!token) {
          throw normalizeOrchestraClientError(
            `Remote bearer token is required for ${operation}.`,
            {
              operation,
              source: "adapter",
              fallbackMessage: `Remote bearer token is required for ${operation}.`,
              code: "unauthorized",
              retryable: false,
              details: createBootstrapDetails(bootstrap),
            },
          );
        }
        init.credentials = "omit";
        headers.set("Authorization", `Bearer ${token}`);
        break;
      }
      default:
        init.credentials = "omit";
        break;
    }

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, init);
      connectionController?.markHostOnline();
    } catch (error) {
      if (error instanceof OrchestraClientError) {
        connectionController?.markHostOffline(error);
        throw error;
      }
      if (isAbortError(error)) {
        const normalized = normalizeOrchestraClientError(error, {
          operation,
          source: "remote_api",
          fallbackMessage: `Remote request for ${operation} was cancelled.`,
          code: "cancelled",
          retryable: false,
          details: createBootstrapDetails(bootstrap, {
            url,
            method: init.method ?? "GET",
          }),
        });
        throw normalized;
      }
      const normalized = normalizeOrchestraClientError(error, {
        operation,
        source: "remote_api",
        fallbackMessage: `Remote request for ${operation} failed before the server responded.`,
        code: "offline",
        details: createBootstrapDetails(bootstrap, {
          url,
          method: init.method ?? "GET",
        }),
      });
      connectionController?.markHostOffline(normalized);
      throw normalized;
    }

    if (!response.ok) {
      const parsed = parseRemoteApiErrorText(
        await response.text(),
        `Remote request for ${operation} failed with ${response.status}.`,
      );
      throw normalizeOrchestraClientError(parsed.message, {
        operation,
        source: "remote_api",
        fallbackMessage: `Remote request for ${operation} failed with ${response.status}.`,
        status: response.status,
        details: createBootstrapDetails(bootstrap, {
          url,
          method: init.method ?? "GET",
          response: parsed.details,
        }),
      });
    }

    const parseAs = options.parseAs ?? "json";
    if (parseAs === "none") {
      return undefined as T;
    }

    const rawText = await response.text();
    if (parseAs === "text") {
      return rawText as T;
    }

    try {
      return JSON.parse(rawText) as T;
    } catch (error) {
      throw normalizeOrchestraClientError(error, {
        operation,
        source: "remote_api",
        fallbackMessage: `Remote response for ${operation} was not valid JSON.`,
        code: "transport",
        details: createBootstrapDetails(bootstrap, {
          url,
          method: init.method ?? "GET",
          responseText: rawText,
        }),
      });
    }
  }

  return {
    bootstrap,
    assertCapability,
    assertRemoteBootstrap,
    getWebSocketUrl,
    requestJson: <T>(operation: string, options: RemoteApiRequestOptions) =>
      request<T>(operation, { ...options, parseAs: "json" }),
    requestText: (operation: string, options: RemoteApiRequestOptions) =>
      request<string>(operation, { ...options, parseAs: "text" }),
    requestVoid: (operation: string, options: RemoteApiRequestOptions) =>
      request<void>(operation, { ...options, parseAs: "none" }),
  };
}

export function createRemoteApiTaskListQuery(options?: TaskListOptions) {
  return normalizeTaskListQuery(options);
}

export function describeRemoteApiError(error: unknown, fallback: string) {
  return getErrorMessage(error, fallback);
}

export async function fetchRemoteApiAppInfo(
  transport: RemoteApiTransport,
  bootstrap: OrchestraClientBootstrap,
): Promise<AppInfo> {
  return transport.requestJson<AppInfo>("app.getInfo", {
    path: "/api/v1/app-info",
    allowAnonymous: bootstrap.authMode === "none",
  });
}
