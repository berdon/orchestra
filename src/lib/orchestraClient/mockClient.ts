import { createOrchestraClient } from "./baseClient";
import {
  buildOrchestraClientBootstrap,
  createOptimisticOrchestraClientBootstrap,
} from "./bootstrapFactory";
import type { OrchestraClient, OrchestraClientBinding } from "./client";
import type { OrchestraClientServiceBindings } from "./serviceBindings";
import { mockOrchestraClientServiceBindings } from "./mockBindings";

export function createOptimisticMockOrchestraClientBootstrap() {
  return createOptimisticOrchestraClientBootstrap("mock");
}

export async function buildMockOrchestraClientBootstrap(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
) {
  return buildOrchestraClientBootstrap("mock", services.app.getInfo);
}

export function createMockOrchestraClient(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
): OrchestraClient {
  return createOrchestraClient(() => buildMockOrchestraClientBootstrap(services), services);
}

export function createMockOrchestraClientBinding(
  services: OrchestraClientServiceBindings = mockOrchestraClientServiceBindings,
): OrchestraClientBinding {
  return {
    client: createMockOrchestraClient(services),
    bootstrap: createOptimisticMockOrchestraClientBootstrap(),
  };
}
