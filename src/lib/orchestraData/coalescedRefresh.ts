import { useCallback, useEffect, useRef } from "react";

interface UseCoalescedRefreshOptions {
  delayMs?: number;
  disabled?: boolean;
  onError?: (error: unknown) => void;
}

export function useCoalescedRefresh(
  refresh: () => Promise<void> | void,
  options?: UseCoalescedRefreshOptions,
) {
  const delayMs = options?.delayMs ?? 200;
  const disabled = options?.disabled ?? false;
  const onError = options?.onError;
  const refreshRef = useRef(refresh);
  const onErrorRef = useRef(onError);
  const disabledRef = useRef(disabled);
  const scheduledRefreshRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const trailingRefreshRequestedRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const clearScheduledRefresh = useCallback(() => {
    if (scheduledRefreshRef.current !== null) {
      window.clearTimeout(scheduledRefreshRef.current);
      scheduledRefreshRef.current = null;
    }
  }, []);

  const requestRefresh = useCallback(() => {
    if (disabledRef.current) {
      return;
    }

    if (scheduledRefreshRef.current !== null) {
      return;
    }

    if (refreshInFlightRef.current) {
      trailingRefreshRequestedRef.current = true;
      return;
    }

    scheduledRefreshRef.current = window.setTimeout(() => {
      scheduledRefreshRef.current = null;
      refreshInFlightRef.current = true;
      void Promise.resolve(refreshRef.current())
        .catch((error) => {
          onErrorRef.current?.(error);
        })
        .finally(() => {
          refreshInFlightRef.current = false;
          if (!trailingRefreshRequestedRef.current) {
            return;
          }

          trailingRefreshRequestedRef.current = false;
          if (!disabledRef.current) {
            requestRefresh();
          }
        });
    }, delayMs);
  }, [delayMs]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    clearScheduledRefresh();
    trailingRefreshRequestedRef.current = false;
  }, [clearScheduledRefresh, disabled]);

  useEffect(() => () => {
    clearScheduledRefresh();
    trailingRefreshRequestedRef.current = false;
  }, [clearScheduledRefresh]);

  return requestRefresh;
}
