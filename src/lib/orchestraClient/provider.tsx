import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { OrchestraClient, OrchestraClientBinding } from "./client";
import type { OrchestraClientBootstrap } from "./bootstrap";
import { createDefaultOrchestraClientBinding } from "./defaultClient";

const OrchestraClientContext = createContext<OrchestraClientBinding | null>(null);

export interface OrchestraClientProviderProps {
  binding?: OrchestraClientBinding;
  children: ReactNode;
}

export function OrchestraClientProvider({ binding, children }: OrchestraClientProviderProps) {
  const defaultBindingRef = useRef<OrchestraClientBinding | null>(null);
  if (!binding && !defaultBindingRef.current) {
    defaultBindingRef.current = createDefaultOrchestraClientBinding();
  }

  const [resolvedBinding, setResolvedBinding] = useState<OrchestraClientBinding>(
    () => binding ?? defaultBindingRef.current ?? createDefaultOrchestraClientBinding(),
  );

  useEffect(() => {
    if (binding) {
      setResolvedBinding(binding);
      return;
    }

    const defaultBinding = defaultBindingRef.current ?? createDefaultOrchestraClientBinding();
    if (!defaultBindingRef.current) {
      defaultBindingRef.current = defaultBinding;
    }

    setResolvedBinding(defaultBinding);

    let cancelled = false;
    void defaultBinding.client.getBootstrap()
      .then((bootstrap) => {
        if (!cancelled) {
          setResolvedBinding({
            client: defaultBinding.client,
            bootstrap,
          });
        }
      })
      .catch((error) => {
        console.error("[orchestra-client.bootstrap] Unable to resolve default OrchestraClient bootstrap.", error);
      });

    return () => {
      cancelled = true;
    };
  }, [binding]);

  return (
    <OrchestraClientContext.Provider value={resolvedBinding}>
      {children}
    </OrchestraClientContext.Provider>
  );
}

export function useOrchestraClient(): OrchestraClient {
  const value = useContext(OrchestraClientContext);
  if (!value) {
    throw new Error("useOrchestraClient must be used within an OrchestraClientProvider.");
  }
  return value.client;
}

export function useOrchestraBootstrap(): OrchestraClientBootstrap {
  const value = useContext(OrchestraClientContext);
  if (!value) {
    throw new Error("useOrchestraBootstrap must be used within an OrchestraClientProvider.");
  }
  return value.bootstrap;
}
