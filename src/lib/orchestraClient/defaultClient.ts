import type { OrchestraClient, OrchestraClientBinding } from "./client";
import type { OrchestraClientBootstrap, OrchestraClientHostKind } from "./bootstrap";
import { isTauriAvailable } from "../mockOrchestra/host";
import {
  buildMockOrchestraClientBootstrap,
  createMockOrchestraClient,
  createMockOrchestraClientBinding,
  createOptimisticMockOrchestraClientBootstrap,
} from "./mockClient";
import {
  buildTauriOrchestraClientBootstrap,
  createOptimisticTauriOrchestraClientBootstrap,
  createTauriOrchestraClient,
  createTauriOrchestraClientBinding,
} from "./tauriClient";

export function resolveDefaultOrchestraClientHostKind(): OrchestraClientHostKind {
  return isTauriAvailable() ? "tauri" : "mock";
}

export function createOptimisticOrchestraClientBootstrap(): OrchestraClientBootstrap {
  return resolveDefaultOrchestraClientHostKind() === "tauri"
    ? createOptimisticTauriOrchestraClientBootstrap()
    : createOptimisticMockOrchestraClientBootstrap();
}

export async function buildDefaultOrchestraClientBootstrap(): Promise<OrchestraClientBootstrap> {
  return resolveDefaultOrchestraClientHostKind() === "tauri"
    ? buildTauriOrchestraClientBootstrap()
    : buildMockOrchestraClientBootstrap();
}

export function createDefaultOrchestraClient(): OrchestraClient {
  return resolveDefaultOrchestraClientHostKind() === "tauri"
    ? createTauriOrchestraClient()
    : createMockOrchestraClient();
}

export function createDefaultOrchestraClientBinding(): OrchestraClientBinding {
  return resolveDefaultOrchestraClientHostKind() === "tauri"
    ? createTauriOrchestraClientBinding()
    : createMockOrchestraClientBinding();
}
