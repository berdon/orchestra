import type { OrchestraClient } from "../orchestraClient";
import type { JsonValue, SettingsTab } from "../../types";
import {
  OrchestraClientError,
  type OrchestraClientErrorCode,
  type OrchestraClientErrorShape,
  toOrchestraClientError,
} from "../orchestraClient";

const MODEL_AUTH_ERROR_PREFIX = "__ORCHESTRA_MODEL_AUTH_ERROR__:";

export type UiErrorKind =
  | "offline"
  | "unsupported"
  | "authorization"
  | "setup_required"
  | "validation"
  | "not_found"
  | "conflict"
  | "timeout"
  | "transport"
  | "unknown";

export interface SettingsNavigationTarget {
  tab: SettingsTab;
  detailTab?: string | null;
  providerId?: string | null;
}

export interface ModelAuthFailureDetails {
  kind: "model_auth_required";
  code: "model_auth_required";
  reason: "missing" | "expired" | "invalid" | "unknown" | string;
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  message: string;
  detail: string;
  settingsTab: SettingsTab;
  settingsDetailTab: string;
  rawMessage: string;
}

export interface UiErrorState {
  kind: UiErrorKind;
  title: string;
  message: string;
  detail?: string | null;
  retryable: boolean;
  code: OrchestraClientErrorCode;
  error: OrchestraClientErrorShape;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEmbeddedModelAuthFailureMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed.startsWith(MODEL_AUTH_ERROR_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(MODEL_AUTH_ERROR_PREFIX.length));
    return isModelAuthFailureDetails(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isModelAuthFailureDetails(value: unknown): value is ModelAuthFailureDetails {
  if (!isObject(value)) {
    return false;
  }

  return value.kind === "model_auth_required"
    && value.code === "model_auth_required"
    && typeof value.message === "string"
    && typeof value.detail === "string"
    && typeof value.settingsTab === "string"
    && typeof value.settingsDetailTab === "string"
    && typeof value.rawMessage === "string";
}

function extractModelAuthFailureDetails(error: unknown): ModelAuthFailureDetails | null {
  if (error instanceof OrchestraClientError && isModelAuthFailureDetails(error.details)) {
    return error.details;
  }

  if (typeof error === "string") {
    return parseEmbeddedModelAuthFailureMessage(error);
  }

  if (error instanceof Error) {
    return parseEmbeddedModelAuthFailureMessage(error.message);
  }

  if (isModelAuthFailureDetails(error)) {
    return error;
  }

  if (isObject(error) && isModelAuthFailureDetails(error.details)) {
    return error.details;
  }

  return null;
}

export function getModelAuthFailureDetails(error: UiErrorState | unknown): ModelAuthFailureDetails | null {
  if (isObject(error) && isObject((error as { error?: unknown }).error)) {
    return extractModelAuthFailureDetails((error as { error?: unknown }).error);
  }
  return extractModelAuthFailureDetails(error);
}

export function getModelAuthFailureSettingsTarget(error: UiErrorState | unknown): SettingsNavigationTarget | null {
  const details = getModelAuthFailureDetails(error);
  if (!details) {
    return null;
  }

  return {
    tab: details.settingsTab,
    detailTab: details.settingsDetailTab,
    providerId: details.providerId ?? null,
  };
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
    case "not_found":
      return "not_found";
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
    case "not_found":
      return "Not found";
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
    case "not_found":
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
  const modelAuthFailure = extractModelAuthFailureDetails(error)
    ?? extractModelAuthFailureDetails(normalized);

  if (modelAuthFailure) {
    const decoratedError = new OrchestraClientError({
      ...normalized,
      code: "unauthorized",
      userMessage: modelAuthFailure.message,
      retryable: false,
      details: modelAuthFailure as unknown as JsonValue,
    });

    return {
      kind: "setup_required",
      title: "Harness setup required",
      message: modelAuthFailure.message,
      detail: modelAuthFailure.detail,
      retryable: false,
      code: decoratedError.code,
      error: decoratedError,
    };
  }

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
