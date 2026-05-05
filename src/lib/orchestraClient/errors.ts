import type { JsonValue } from "../../types";

export type OrchestraClientErrorCode =
  | "unknown"
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "offline"
  | "network"
  | "transport"
  | "unsupported";

export type OrchestraClientErrorSource =
  | "adapter"
  | "tauri"
  | "remote_api"
  | "mock"
  | "frontend";

export interface OrchestraClientErrorShape {
  name: "OrchestraClientError";
  code: OrchestraClientErrorCode;
  message: string;
  userMessage?: string | null;
  retryable: boolean;
  status?: number | null;
  source: OrchestraClientErrorSource;
  operation: string;
  details?: JsonValue | null;
}

export interface NormalizeOrchestraClientErrorOptions {
  operation: string;
  source: OrchestraClientErrorSource;
  fallbackMessage: string;
  code?: OrchestraClientErrorCode;
  retryable?: boolean;
  status?: number | null;
  details?: JsonValue | null;
  userMessage?: string | null;
}

export class OrchestraClientError extends Error implements OrchestraClientErrorShape {
  override name = "OrchestraClientError" as const;

  readonly code: OrchestraClientErrorCode;
  readonly userMessage: string | null;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly source: OrchestraClientErrorSource;
  readonly operation: string;
  readonly details: JsonValue | null;

  constructor(options: OrchestraClientErrorShape) {
    super(options.message);
    this.code = options.code;
    this.userMessage = options.userMessage ?? null;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.source = options.source;
    this.operation = options.operation;
    this.details = options.details ?? null;
  }
}

export function mapHttpStatusToOrchestraClientErrorCode(
  status?: number | null,
): OrchestraClientErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "validation";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 408:
      return "timeout";
    case 501:
      return "unsupported";
    case 502:
    case 503:
    case 504:
      return "unavailable";
    default:
      return "unknown";
  }
}

export function isRetryableOrchestraClientErrorCode(code: OrchestraClientErrorCode) {
  return code === "offline"
    || code === "rate_limited"
    || code === "timeout"
    || code === "unavailable"
    || code === "network"
    || code === "transport";
}

function getErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallbackMessage;
}

function deriveOperationSpecificErrorOverrides(
  operation: string,
  message: string,
): Pick<OrchestraClientErrorShape, "code" | "userMessage"> | null {
  const normalizedOperation = operation.trim();
  if (
    !normalizedOperation.startsWith("sessions.")
    && normalizedOperation !== "workers.ensureAgentSession"
  ) {
    return null;
  }

  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage.includes("session")) {
    return null;
  }

  if (
    normalizedMessage.includes("canonical session row")
    || normalizedMessage.includes("canonical session rows")
    || normalizedMessage.includes("canonical transcript path")
    || normalizedMessage.includes("unable to find session")
    || (/^session\s+[a-z0-9-]+\s+was not found/.test(normalizedMessage))
  ) {
    return {
      code: "not_found",
      userMessage:
        "This session is no longer available. Refresh the session list or reopen the latest chat to continue.",
    };
  }

  return null;
}

export function inferOrchestraClientErrorCode(
  error: unknown,
  fallback: OrchestraClientErrorCode = "unknown",
): OrchestraClientErrorCode {
  const message = getErrorMessage(error, "").toLowerCase();
  if (!message) {
    return fallback;
  }
  if (message.includes("offline") || message.includes("network is unreachable") || message.includes("failed to fetch") || message.includes("internet connection")) {
    return "offline";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("unauthorized") || message.includes("authentication") || message.includes("not authenticated") || message.includes("login required") || message.includes("bearer token")) {
    return "unauthorized";
  }
  if (message.includes("forbidden") || message.includes("permission denied") || message.includes("access denied")) {
    return "forbidden";
  }
  if (message.includes("unsupported") || message.includes("not implemented") || message.includes("unavailable in this host")) {
    return "unsupported";
  }
  if (message.includes("validation") || message.includes("invalid ") || message.includes("must be ")) {
    return "validation";
  }
  if (message.includes("conflict") || message.includes("already exists")) {
    return "conflict";
  }
  if (message.includes("not found") || message.includes("missing")) {
    return "not_found";
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limited";
  }
  if (message.includes("cancel") || message.includes("aborted")) {
    return "cancelled";
  }
  if (message.includes("unavailable") || message.includes("temporarily unavailable") || message.includes("service unavailable")) {
    return "unavailable";
  }
  if (message.includes("network") || message.includes("socket") || message.includes("websocket") || message.includes("transport")) {
    return "transport";
  }
  return fallback;
}

export function normalizeOrchestraClientError(
  error: unknown,
  options: NormalizeOrchestraClientErrorOptions,
): OrchestraClientError {
  const message = getErrorMessage(error, options.fallbackMessage);
  const overrides = deriveOperationSpecificErrorOverrides(
    options.operation,
    message,
  );
  const code = options.code
    ?? overrides?.code
    ?? inferOrchestraClientErrorCode(
      error,
      mapHttpStatusToOrchestraClientErrorCode(options.status),
    );
  const retryable = options.retryable ?? isRetryableOrchestraClientErrorCode(code);

  return new OrchestraClientError({
    name: "OrchestraClientError",
    code,
    message,
    userMessage: options.userMessage ?? overrides?.userMessage ?? null,
    retryable,
    status: options.status ?? null,
    source: options.source,
    operation: options.operation,
    details: options.details ?? null,
  });
}

export function toOrchestraClientError(
  error: unknown,
  options: NormalizeOrchestraClientErrorOptions,
): OrchestraClientError {
  return error instanceof OrchestraClientError
    ? error
    : normalizeOrchestraClientError(error, options);
}
