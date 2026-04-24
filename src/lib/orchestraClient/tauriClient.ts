import { createOrchestraClient } from "./baseClient";
import {
  buildOrchestraClientBootstrap,
  createOptimisticOrchestraClientBootstrap,
} from "./bootstrapFactory";
import { createOptimisticConnectionSnapshot, createStaticConnectionService } from "./connection";
import type { OrchestraClient, OrchestraClientBinding } from "./client";
import { withNormalizedBindingErrors, type OrchestraClientServiceBindings } from "./serviceBindings";
import { createLocalNotificationsExtension } from "./localNotificationsExtension";
import { createTauriHostAdminExtension } from "./tauriHostAdminExtension";
import { tauriOrchestraClientServiceBindings } from "./tauriBindings";
import { createTauriShellExtension } from "./tauriShellExtension";

export function createOptimisticTauriOrchestraClientBootstrap() {
  return createOptimisticOrchestraClientBootstrap("tauri");
}

export async function buildTauriOrchestraClientBootstrap(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
) {
  return buildOrchestraClientBootstrap("tauri", withNormalizedBindingErrors(services, "tauri").app.getInfo);
}

export function createTauriOrchestraClient(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
): OrchestraClient {
  const normalizedServices = withNormalizedBindingErrors(services, "tauri");
  const optimisticBootstrap = createOptimisticTauriOrchestraClientBootstrap();
  return createOrchestraClient(
    () => buildTauriOrchestraClientBootstrap(normalizedServices),
    normalizedServices,
    {
      connection: createStaticConnectionService(createOptimisticConnectionSnapshot(optimisticBootstrap)),
      shell: createTauriShellExtension(),
      notifications: createLocalNotificationsExtension(),
      hostAdmin: createTauriHostAdminExtension(),
    },
  );
}

export function createTauriOrchestraClientBinding(
  services: OrchestraClientServiceBindings = tauriOrchestraClientServiceBindings,
): OrchestraClientBinding {
  const bootstrap = createOptimisticTauriOrchestraClientBootstrap();
  return {
    client: createTauriOrchestraClient(services),
    bootstrap,
  };
}
