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

function getErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallbackMessage;
}

export function normalizeOrchestraClientError(
  error: unknown,
  options: NormalizeOrchestraClientErrorOptions,
): OrchestraClientError {
  const code = options.code ?? mapHttpStatusToOrchestraClientErrorCode(options.status);
  const retryable = options.retryable ?? (
    code === "rate_limited"
    || code === "timeout"
    || code === "unavailable"
    || code === "network"
    || code === "transport"
  );

  return new OrchestraClientError({
    name: "OrchestraClientError",
    code,
    message: getErrorMessage(error, options.fallbackMessage),
    userMessage: options.userMessage ?? null,
    retryable,
    status: options.status ?? null,
    source: options.source,
    operation: options.operation,
    details: options.details ?? null,
  });
}
