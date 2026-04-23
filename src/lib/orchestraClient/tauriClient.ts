import { createOrchestraClient } from "./baseClient";
import {
  buildOrchestraClientBootstrap,
  createOptimisticOrchestraClientBootstrap,
} from "./bootstrapFactory";
import type { OrchestraClient, OrchestraClientBinding } from "./client";
import type { OrchestraClientServiceBindings } from "./serviceBindings";
import { tauriOrchestraClientServiceBindings } from "./tauriBindings";

export function createOptimisticTauriOrchestraClientBootstrap() {
  return createOptimisticOrchestraClientBootstrap("tauri");
}

export async function buildTauriOrchestraClientBootstrap(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
) {
  return buildOrchestraClientBootstrap("tauri", services.app.getInfo);
}

export function createTauriOrchestraClient(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
): OrchestraClient {
  return createOrchestraClient(() => buildTauriOrchestraClientBootstrap(services), services);
}

export function createTauriOrchestraClientBinding(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
): OrchestraClientBinding {
  return {
    client: createTauriOrchestraClient(services),
    bootstrap: createOptimisticTauriOrchestraClientBootstrap(),
  };
}
