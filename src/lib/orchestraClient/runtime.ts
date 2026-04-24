import type { OrchestraClientBinding } from "./client";

let activeOrchestraClientBinding: OrchestraClientBinding | null = null;

export function registerActiveOrchestraClientBinding(binding: OrchestraClientBinding | null) {
  activeOrchestraClientBinding = binding;
}

export function getActiveOrchestraClientBinding() {
  return activeOrchestraClientBinding;
}

export function getHostedWebOrchestraClientBinding() {
  return activeOrchestraClientBinding?.bootstrap.hostKind === "remote_api"
    ? activeOrchestraClientBinding
    : null;
}
