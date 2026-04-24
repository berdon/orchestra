import { useEffect, useState } from "react";

import { useOrchestraClient } from "../orchestraClient";
import type { OrchestraConnectionSnapshot } from "../orchestraClient";

export function useOrchestraConnection(): OrchestraConnectionSnapshot {
  const orchestraClient = useOrchestraClient();
  const [snapshot, setSnapshot] = useState<OrchestraConnectionSnapshot>(() => orchestraClient.connection.getSnapshot());

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void orchestraClient.connection.subscribe((nextSnapshot) => {
      if (!cancelled) {
        setSnapshot(nextSnapshot);
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
  }, [orchestraClient]);

  return snapshot;
}
