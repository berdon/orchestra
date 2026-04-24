import type { OrchestraClient } from "../orchestraClient";
import {
  OrchestraClientError,
  type OrchestraClientErrorCode,
  type OrchestraClientErrorShape,
  toOrchestraClientError,
} from "../orchestraClient";

export type UiErrorKind =
  | "offline"
  | "unsupported"
  | "authorization"
  | "validation"
  | "conflict"
  | "timeout"
  | "transport"
  | "unknown";

export interface UiErrorState {
  kind: UiErrorKind;
  title: string;
  message: string;
  detail?: string | null;
  retryable: boolean;
  code: OrchestraClientErrorCode;
  error: OrchestraClientErrorShape;
}

function mapUiErrorKind(code: OrchestraClientErrorCode): UiErrorKind {
  switch (code) {
    case "offline":
      return "offline";
    case "unsupported":
      return "unsupported";
    case "unauthorized":
    case "forbidden":
      return "authorization";
    case "validation":
      return "validation";
    case "conflict":
      return "conflict";
    case "timeout":
      return "timeout";
    case "network":
    case "transport":
    case "unavailable":
    case "rate_limited":
      return "transport";
    default:
      return "unknown";
  }
}

function mapUiErrorTitle(error: OrchestraClientErrorShape): string {
  switch (error.code) {
    case "offline":
      return "Offline";
    case "unsupported":
      return "Unsupported in this host";
    case "unauthorized":
      return "Sign-in required";
    case "forbidden":
      return "Access denied";
    case "validation":
      return "Check the request";
    case "conflict":
      return "Refresh and try again";
    case "timeout":
      return "Request timed out";
    case "network":
    case "transport":
    case "unavailable":
    case "rate_limited":
      return "Connection issue";
    default:
      return "Something went wrong";
  }
}

function mapUiErrorMessage(error: OrchestraClientErrorShape, fallback: string): string {
  if (error.userMessage && error.userMessage.trim()) {
    return error.userMessage;
  }

  switch (error.code) {
    case "offline":
      return "Orchestra is offline right now. You can keep any cached content open and retry when connectivity returns.";
    case "unsupported":
      return error.message || fallback;
    case "unauthorized":
      return "You need to sign in again before this action can continue.";
    case "forbidden":
      return "This action is not available with the current permissions.";
    case "validation":
      return error.message || fallback;
    case "conflict":
      return "The data changed underneath you. Refresh the page data and try again.";
    case "timeout":
      return "The request took too long to complete. Retry when the connection is stable.";
    case "network":
    case "transport":
    case "unavailable":
    case "rate_limited":
      return error.message || fallback;
    default:
      return error.message || fallback;
  }
}

export function toUiErrorState(error: unknown, fallback: string): UiErrorState {
  const normalized = error instanceof OrchestraClientError
    ? error
    : toOrchestraClientError(error, {
        operation: "ui.unknown",
        source: "frontend",
        fallbackMessage: fallback,
      });

  return {
    kind: mapUiErrorKind(normalized.code),
    title: mapUiErrorTitle(normalized),
    message: mapUiErrorMessage(normalized, fallback),
    detail: normalized.code === "unsupported" && normalized.message !== fallback ? normalized.message : null,
    retryable: normalized.retryable,
    code: normalized.code,
    error: normalized,
  };
}

export async function reportUiError(
  orchestraClient: OrchestraClient,
  target: string,
  error: unknown,
  fallback: string,
): Promise<UiErrorState> {
  try {
    await orchestraClient.app.reportError(target, error, fallback);
  } catch (reportingError) {
    console.error(`[${target}] Unable to report UI error`, reportingError);
  }
  return toUiErrorState(error, fallback);
}
