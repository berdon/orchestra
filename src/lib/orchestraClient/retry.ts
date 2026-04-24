import { isRetryableOrchestraClientErrorCode, toOrchestraClientError } from "./errors";

export interface OrchestraReadRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function shouldAutoRetryOrchestraRead(error: unknown) {
  const normalized = toOrchestraClientError(error, {
    operation: "read.retry",
    source: "frontend",
    fallbackMessage: "Read request failed.",
  });
  return normalized.retryable || isRetryableOrchestraClientErrorCode(normalized.code);
}

export async function retryOrchestraRead<T>(
  operation: () => Promise<T>,
  options?: OrchestraReadRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  const maxDelayMs = options?.maxDelayMs ?? 2_000;
  const jitterRatio = options?.jitterRatio ?? 0.2;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts || !shouldAutoRetryOrchestraRead(error)) {
        throw error;
      }
      const baseDelay = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
      const jitterWindow = Math.max(1, Math.round(baseDelay * jitterRatio));
      const jitter = Math.round((Math.random() * jitterWindow * 2) - jitterWindow);
      await sleep(Math.max(0, baseDelay + jitter));
    }
  }

  throw lastError;
}
