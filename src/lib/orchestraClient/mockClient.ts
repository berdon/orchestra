import { createOrchestraClient } from "./baseClient";
import {
  buildOrchestraClientBootstrap,
  createOptimisticOrchestraClientBootstrap,
} from "./bootstrapFactory";
import { createOptimisticConnectionSnapshot, createStaticConnectionService } from "./connection";
import type { OrchestraClient, OrchestraClientBinding } from "./client";
import { createMockHostAdminExtension } from "./mockHostAdminExtension";
import { mockOrchestraClientServiceBindings } from "./mockBindings";
import { createMockShellExtension } from "./mockShellExtension";
import { withNormalizedBindingErrors, type OrchestraClientServiceBindings } from "./serviceBindings";

export function createOptimisticMockOrchestraClientBootstrap() {
  return createOptimisticOrchestraClientBootstrap("mock");
}

export async function buildMockOrchestraClientBootstrap(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
) {
  return buildOrchestraClientBootstrap("mock", withNormalizedBindingErrors(services, "mock").app.getInfo);
}

export function createMockOrchestraClient(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
): OrchestraClient {
  const normalizedServices = withNormalizedBindingErrors(services, "mock");
  const optimisticBootstrap = createOptimisticMockOrchestraClientBootstrap();
  return createOrchestraClient(
    () => buildMockOrchestraClientBootstrap(normalizedServices),
    normalizedServices,
    {
      connection: createStaticConnectionService(createOptimisticConnectionSnapshot(optimisticBootstrap)),
      shell: createMockShellExtension(),
      hostAdmin: createMockHostAdminExtension(),
    },
  );
}

export function createMockOrchestraClientBinding(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
): OrchestraClientBinding {
  const bootstrap = createOptimisticMockOrchestraClientBootstrap();
  return {
    client: createMockOrchestraClient(services),
    bootstrap,
  };
}
