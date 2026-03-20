import { invoke } from "@tauri-apps/api/core";

import type { AgentDefinition, PolicyDefinition, PolicySummary, ResolvedPermissions, RoleDefinition } from "../types";
import { SUPERVISOR_POLICY_ID, buildEffectivePermissions, uniq } from "./access";
import { isTauriAvailable } from "./tauri";

const POLICY_STORAGE_KEY = "orchestra.mock.policies";
const ROLE_STORAGE_KEY = "orchestra.mock.roles";
const AGENT_STORAGE_KEY = "orchestra.mock.agents";

function nowIso() {
  return new Date().toISOString();
}

function getStoredValue<T>(key: string): T | null {
  const value = window.localStorage.getItem(key);
  return value ? (JSON.parse(value) as T) : null;
}

function setStoredValue<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function seedMockPolicies(): PolicyDefinition[] {
  const timestamp = nowIso();
  return [
    {
      id: SUPERVISOR_POLICY_ID,
      slug: "supervisor",
      name: "Supervisor",
      description: "Built-in immutable policy that grants the full Orchestra surface.",
      permissions: ["*"],
      system: true,
      immutable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function ensureMockPolicies() {
  const existing = getStoredValue<PolicyDefinition[]>(POLICY_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const seeded = seedMockPolicies();
  setStoredValue(POLICY_STORAGE_KEY, seeded);
  return seeded;
}

function toPolicySummary(policy: PolicyDefinition): PolicySummary {
  return {
    id: policy.id,
    slug: policy.slug,
    name: policy.name,
    description: policy.description,
    system: policy.system,
    immutable: policy.immutable,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function getStoredRoles() {
  return (getStoredValue<RoleDefinition[]>(ROLE_STORAGE_KEY) ?? []).map((role) => ({
    ...role,
    policyIds: role.policyIds ?? [],
    directPermissions: role.directPermissions ?? [],
  }));
}

function getStoredAgents() {
  return (getStoredValue<AgentDefinition[]>(AGENT_STORAGE_KEY) ?? []).map((agent) => ({
    ...agent,
    policyIds: agent.policyIds ?? [],
    directPermissions: agent.directPermissions ?? [],
  }));
}

function resolveRolePermissionsFromMock(roleId: string): ResolvedPermissions {
  const role = getStoredRoles().find((entry) => entry.id === roleId);
  if (!role) {
    throw new Error(`Role ${roleId} was not found`);
  }

  const policies = ensureMockPolicies().filter((policy) => role.policyIds?.includes(policy.id));
  const effective = buildEffectivePermissions({
    attachedPolicies: policies,
    directPermissions: role.directPermissions,
  });

  return {
    actorType: "role",
    actorId: role.id,
    inheritedRoleId: null,
    policyIds: uniq(role.policyIds ?? []),
    permissions: effective.permissions,
    grantsFullAccess: effective.grantsFullAccess,
  };
}

function resolveAgentPermissionsFromMock(agentId: string): ResolvedPermissions {
  const agent = getStoredAgents().find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} was not found`);
  }

  const inherited = agent.roleId ? resolveRolePermissionsFromMock(agent.roleId) : null;
  const policies = ensureMockPolicies().filter((policy) => agent.policyIds?.includes(policy.id));
  const effective = buildEffectivePermissions({
    inheritedPermissions: inherited?.permissions,
    attachedPolicies: policies,
    directPermissions: agent.directPermissions,
  });

  return {
    actorType: "agent",
    actorId: agent.id,
    inheritedRoleId: agent.roleId ?? null,
    policyIds: uniq([...(inherited?.policyIds ?? []), ...(agent.policyIds ?? [])]),
    permissions: effective.permissions,
    grantsFullAccess: effective.grantsFullAccess,
  };
}

export async function listPolicies(): Promise<PolicySummary[]> {
  if (!isTauriAvailable()) {
    return ensureMockPolicies().map(toPolicySummary);
  }

  return invoke<PolicySummary[]>("list_policies");
}

export async function getPolicy(policyId: string): Promise<PolicyDefinition> {
  if (!isTauriAvailable()) {
    const policy = ensureMockPolicies().find((entry) => entry.id === policyId);
    if (!policy) {
      throw new Error(`Policy ${policyId} was not found`);
    }
    return policy;
  }

  return invoke<PolicyDefinition>("get_policy", { policyId });
}

export async function getRolePermissions(roleId: string): Promise<ResolvedPermissions> {
  if (!isTauriAvailable()) {
    return resolveRolePermissionsFromMock(roleId);
  }

  return invoke<ResolvedPermissions>("get_role_permissions", { roleId });
}

export async function getAgentPermissions(agentId: string): Promise<ResolvedPermissions> {
  if (!isTauriAvailable()) {
    return resolveAgentPermissionsFromMock(agentId);
  }

  return invoke<ResolvedPermissions>("get_agent_permissions", { agentId });
}
