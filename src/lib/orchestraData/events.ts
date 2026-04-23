import { useEffect, useRef } from "react";

import type { OrchestraClientEvent } from "../orchestraClient";
import { useOrchestraClient } from "../orchestraClient";

interface UseOrchestraEventSubscriptionOptions {
  disabled?: boolean;
}

export function useOrchestraEventSubscription(
  handler: (event: OrchestraClientEvent) => void,
  options?: UseOrchestraEventSubscriptionOptions,
) {
  const orchestraClient = useOrchestraClient();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (options?.disabled) {
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void orchestraClient.events.subscribe((event) => {
      if (!cancelled) {
        handlerRef.current(event);
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unsubscribe = dispose;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [orchestraClient, options?.disabled]);
}
