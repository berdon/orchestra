import { invoke } from "@tauri-apps/api/core";

import { getRole, listRoles } from "./roles";
import { createMockSessionRecord, emitMockSessionChange, isTauriAvailable, upsertMockSession } from "./tauri";
import type {
  RoleDefinition,
  RoleInstance,
  RoleOperationsDetail,
  RoleOperationsSnapshot,
  RoleQueueEntry,
  RoleQueueEntryInput,
  RoleSummary,
} from "../types";

const ROLE_QUEUE_STORAGE_KEY = "orchestra.mock.role-queue";
const ROLE_INSTANCE_STORAGE_KEY = "orchestra.mock.role-instances";

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

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

function getMockQueueEntries() {
  return getStoredValue<RoleQueueEntry[]>(ROLE_QUEUE_STORAGE_KEY) ?? [];
}

function setMockQueueEntries(entries: RoleQueueEntry[]) {
  setStoredValue(ROLE_QUEUE_STORAGE_KEY, entries);
}

function getMockRoleInstances() {
  return getStoredValue<RoleInstance[]>(ROLE_INSTANCE_STORAGE_KEY) ?? [];
}

function setMockRoleInstances(instances: RoleInstance[]) {
  setStoredValue(ROLE_INSTANCE_STORAGE_KEY, instances);
}

function toRoleOperationsSnapshot(role: RoleSummary, queueEntries: RoleQueueEntry[], instances: RoleInstance[]): RoleOperationsSnapshot {
  return {
    role,
    queuedCount: queueEntries.filter((entry) => entry.status === "queued").length,
    assignedCount: queueEntries.filter((entry) => entry.status === "assigned").length,
    activeInstanceCount: instances.filter((instance) => instance.status === "running").length,
    idleInstanceCount: instances.filter((instance) => instance.status === "idle").length,
    latestError: instances.find((instance) => instance.lastError)?.lastError ?? null,
  };
}

function toRoleOperationsDetail(role: RoleDefinition, queueEntries: RoleQueueEntry[], instances: RoleInstance[]): RoleOperationsDetail {
  return {
    role,
    queuedCount: queueEntries.filter((entry) => entry.status === "queued").length,
    assignedCount: queueEntries.filter((entry) => entry.status === "assigned").length,
    activeInstanceCount: instances.filter((instance) => instance.status === "running").length,
    idleInstanceCount: instances.filter((instance) => instance.status === "idle").length,
    queueEntries,
    instances,
  };
}

function buildMockWorktreePath(role: RoleDefinition, instanceId: string) {
  return `/mock/worktrees/runtime-${role.slug}-${instanceId.slice(-8)}`;
}

function buildMockSessionId() {
  return createId("session");
}

async function loadMockRoleState(roleId: string) {
  const role = await getRole(roleId);
  const queueEntries = getMockQueueEntries().filter((entry) => entry.roleId === roleId);
  const instances = getMockRoleInstances().filter((instance) => instance.roleId === roleId);
  return { role, queueEntries, instances };
}

function normalizeQueueInput(input: RoleQueueEntryInput): RoleQueueEntryInput {
  return {
    roleId: input.roleId,
    sourceType: input.sourceType.trim() || "manual",
    sourceTaskId: input.sourceTaskId?.trim() || null,
    sourceWorkflowId: input.sourceWorkflowId?.trim() || null,
    sourceLaneId: input.sourceLaneId?.trim() || null,
    title: input.title.trim(),
    summary: input.summary?.trim() || null,
    entryPrompt: input.entryPrompt?.trim() || null,
  };
}

async function runMockDispatch(roleId: string) {
  const role = await getRole(roleId);
  let queueEntries = getMockQueueEntries();
  let instances = getMockRoleInstances();

  while (true) {
    const roleQueue = queueEntries.filter((entry) => entry.roleId === roleId && entry.status === "queued").sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const activeCount = instances.filter((instance) => instance.roleId === roleId && instance.status === "running").length;
    if (roleQueue.length === 0 || activeCount >= role.capacity) {
      break;
    }

    const nextEntry = roleQueue[0]!;
    const instance = {
      id: createId("instance"),
      roleId,
      displayName: `${role.name} ${instances.filter((entry) => entry.roleId === roleId).length + 1}`,
      status: "idle",
      currentQueueEntryId: null,
      sessionId: null,
      worktreePath: null,
      lastHeartbeatAt: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } satisfies RoleInstance;

    const createdSession = createMockSessionRecord(
      `${role.name} · ${nextEntry.title}`,
      `${role.name} runtime is active and ready to continue ${nextEntry.title}.`,
    );
    const assignedInstance: RoleInstance = {
      ...instance,
      status: "running",
      currentQueueEntryId: nextEntry.id,
      sessionId: createdSession.id,
      worktreePath: buildMockWorktreePath(role, instance.id),
      updatedAt: nowIso(),
    };

    instances = [assignedInstance, ...instances];

    upsertMockSession(createdSession);
    emitMockSessionChange({ sessionIds: [createdSession.id], reason: "sessions.role_runtime.created" });

    queueEntries = queueEntries.map((entry) =>
      entry.id === nextEntry.id
        ? {
            ...entry,
            status: "assigned",
            assignedInstanceId: assignedInstance.id,
            startedAt: entry.startedAt ?? nowIso(),
            updatedAt: nowIso(),
          }
        : entry,
    );
  }

  setMockQueueEntries(queueEntries);
  setMockRoleInstances(instances);
  return toRoleOperationsDetail(
    role,
    queueEntries.filter((entry) => entry.roleId === roleId),
    instances.filter((instance) => instance.roleId === roleId),
  );
}

export async function listRoleOperations(includeArchived = false): Promise<RoleOperationsSnapshot[]> {
  if (!isTauriAvailable()) {
    const roles = await listRoles(includeArchived);
    const queueEntries = getMockQueueEntries();
    const instances = getMockRoleInstances();
    return roles.map((role) =>
      toRoleOperationsSnapshot(
        role,
        queueEntries.filter((entry) => entry.roleId === role.id),
        instances.filter((instance) => instance.roleId === role.id),
      ),
    );
  }

  return invoke<RoleOperationsSnapshot[]>("list_role_operations", { includeArchived });
}

export async function getRoleOperations(roleId: string): Promise<RoleOperationsDetail> {
  if (!isTauriAvailable()) {
    const { role, queueEntries, instances } = await loadMockRoleState(roleId);
    return toRoleOperationsDetail(role, queueEntries, instances);
  }

  return invoke<RoleOperationsDetail>("get_role_operations", { roleId });
}

export async function enqueueRoleWork(input: RoleQueueEntryInput): Promise<RoleQueueEntry> {
  const normalized = normalizeQueueInput(input);
  if (!normalized.title) {
    throw new Error("Role work title is required.");
  }

  if (!isTauriAvailable()) {
    const role = await getRole(normalized.roleId);
    const entry: RoleQueueEntry = {
      id: createId("queue"),
      roleId: role.id,
      status: "queued",
      sourceType: normalized.sourceType,
      sourceTaskId: normalized.sourceTaskId ?? null,
      sourceWorkflowId: normalized.sourceWorkflowId ?? null,
      sourceLaneId: normalized.sourceLaneId ?? null,
      title: normalized.title,
      summary: normalized.summary ?? null,
      entryPrompt: normalized.entryPrompt ?? null,
      assignedInstanceId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };

    setMockQueueEntries([entry, ...getMockQueueEntries()]);
    return entry;
  }

  return invoke<RoleQueueEntry>("enqueue_role_work", { input: normalized });
}

export async function dispatchRoleQueue(roleId: string): Promise<RoleOperationsDetail> {
  if (!isTauriAvailable()) {
    return runMockDispatch(roleId);
  }

  return invoke<RoleOperationsDetail>("dispatch_role_queue", { roleId });
}

export async function resetRoleAssignments(roleId: string): Promise<RoleOperationsDetail> {
  if (!isTauriAvailable()) {
    const { role, queueEntries, instances } = await loadMockRoleState(roleId);
    const resetAt = nowIso();
    const nextInstances = getMockRoleInstances().map((entry) =>
      entry.roleId === roleId && entry.currentQueueEntryId
        ? {
            ...entry,
            status: "canceled",
            currentQueueEntryId: null,
            sessionId: null,
            worktreePath: null,
            lastError: "Role assignments reset by operator.",
            updatedAt: resetAt,
          }
        : entry,
    );
    const nextQueueEntries = getMockQueueEntries().map((entry) =>
      entry.roleId === roleId && entry.status === "assigned"
        ? {
            ...entry,
            status: "queued",
            assignedInstanceId: null,
            startedAt: null,
            completedAt: null,
            updatedAt: resetAt,
          }
        : entry,
    );

    setMockRoleInstances(nextInstances);
    setMockQueueEntries(nextQueueEntries);
    return toRoleOperationsDetail(
      role,
      nextQueueEntries.filter((entry) => entry.roleId === roleId),
      nextInstances.filter((entry) => entry.roleId === roleId),
    );
  }

  return invoke<RoleOperationsDetail>("reset_role_assignments", { roleId });
}

export async function releaseRoleInstance(instanceId: string, outcome: "success" | "failure" | "canceled", errorMessage?: string): Promise<RoleOperationsDetail> {
  if (!isTauriAvailable()) {
    const instances = getMockRoleInstances();
    const instance = instances.find((entry) => entry.id === instanceId);
    if (!instance) {
      throw new Error(`Role instance ${instanceId} was not found`);
    }

    let nextQueueEntries = getMockQueueEntries().map((entry) =>
      entry.id === instance.currentQueueEntryId
        ? {
            ...entry,
            status: outcome === "canceled" ? "canceled" : "completed",
            completedAt: nowIso(),
            updatedAt: nowIso(),
          }
        : entry,
    );
    let nextInstances = instances.map((entry) =>
      entry.id === instanceId
        ? {
            ...entry,
            status: outcome === "failure" ? "failed" : outcome === "canceled" ? "canceled" : "completed",
            currentQueueEntryId: null,
            lastError: outcome === "failure" ? errorMessage ?? "Marked failed by operator." : null,
            updatedAt: nowIso(),
          }
        : entry,
    );

    setMockQueueEntries(nextQueueEntries);
    setMockRoleInstances(nextInstances);

    return runMockDispatch(instance.roleId);
  }

  return invoke<RoleOperationsDetail>("release_role_instance", { instanceId, outcome, errorMessage: errorMessage ?? null });
}

export async function disposeRoleInstance(instanceId: string): Promise<RoleOperationsDetail> {
  if (!isTauriAvailable()) {
    const instances = getMockRoleInstances();
    const instance = instances.find((entry) => entry.id === instanceId);
    if (!instance) {
      throw new Error(`Role instance ${instanceId} was not found`);
    }

    if (instance.currentQueueEntryId) {
      throw new Error("Assigned role instances must be released before disposal.");
    }

    const nextInstances = instances.map((entry) =>
      entry.id === instanceId
        ? {
            ...entry,
            status: "completed",
            updatedAt: nowIso(),
          }
        : entry,
    );
    setMockRoleInstances(nextInstances);

    const role = await getRole(instance.roleId);
    return toRoleOperationsDetail(
      role,
      getMockQueueEntries().filter((entry) => entry.roleId === instance.roleId),
      nextInstances.filter((entry) => entry.roleId === instance.roleId),
    );
  }

  return invoke<RoleOperationsDetail>("dispose_role_instance", { instanceId });
}
