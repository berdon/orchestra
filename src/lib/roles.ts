import { invoke } from "@tauri-apps/api/core";

import { buildSeededMockRoles } from "./defaultInstallBaseline";
import { isTauriAvailable } from "./tauri";
import type { RoleDefinition, RoleSummary, RoleUpsertInput, RoleValidationError, RoleValidationResult } from "../types";

const ROLE_STORAGE_KEY = "orchestra.mock.roles";

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugifyRoleName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "role";
}

function getStoredRoles() {
  const value = window.localStorage.getItem(ROLE_STORAGE_KEY);
  return value ? (JSON.parse(value) as RoleDefinition[]) : null;
}

function saveStoredRoles(roles: RoleDefinition[]) {
  window.localStorage.setItem(ROLE_STORAGE_KEY, JSON.stringify(roles));
}

function summarizeRole(role: RoleDefinition): RoleSummary {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    provider: role.provider,
    model: role.model,
    thinkingLevel: role.thinkingLevel,
    capacity: role.capacity,
    policyIds: role.policyIds ?? [],
    directPermissions: role.directPermissions ?? [],
    archived: role.archived,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

function buildMockRoleValidation(input: RoleUpsertInput): RoleValidationResult {
  const errors: RoleValidationError[] = [];
  const name = input.name.trim();
  const provider = input.provider?.trim() || "";
  const model = input.model?.trim() || "";
  const thinkingLevel = input.thinkingLevel?.trim().toLowerCase() || "off";
  const compactionWindow = input.compactionWindow?.trim() || null;

  if (!name) {
    errors.push({ code: "required", path: "name", message: "Role name is required." });
  }

  if (input.capacity < 1 || !Number.isFinite(input.capacity)) {
    errors.push({ code: "invalid", path: "capacity", message: "Role capacity must be at least 1." });
  }

  if (provider && !model) {
    errors.push({ code: "required", path: "model", message: "Select a model when a provider is configured." });
  }

  if (!provider && model) {
    errors.push({ code: "required", path: "provider", message: "Select a provider when a model is configured." });
  }

  if (compactionWindow && !(/^(?:[1-9]\d?|99)%$/.test(compactionWindow) || /^\d+$/.test(compactionWindow) || /^off$/i.test(compactionWindow))) {
    errors.push({ code: "invalid", path: "compactionWindow", message: "Compaction window must be `10%`, a positive token reserve like `16000`, or `off`." });
  }

  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel)) {
    errors.push({ code: "invalid", path: "thinkingLevel", message: "Thinking level must be one of: off, minimal, low, medium, high, xhigh." });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function normalizeMockRoleInput(input: RoleUpsertInput, existing?: RoleDefinition): RoleDefinition {
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const systemPrompt = input.systemPrompt?.trim() || null;
  const provider = input.provider?.trim() || null;
  const model = input.model?.trim() || null;
  const thinkingLevel = input.thinkingLevel?.trim().toLowerCase() || "off";
  const compactionWindow = input.compactionWindow?.trim() || null;
  const timestamp = nowIso();
  const existingRoles = ensureMockRoles();
  const baseSlug = slugifyRoleName(name);
  let slug = baseSlug;
  let suffix = 2;

  while (existingRoles.some((role) => role.slug === slug && role.id !== existing?.id)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return {
    id: existing?.id ?? createId("role"),
    slug,
    name,
    description,
    systemPrompt,
    provider,
    model,
    thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel) ? thinkingLevel : "off",
    capacity: Math.max(1, Math.floor(input.capacity || 0)),
    compactionWindow,
    policyIds: Array.from(new Set(input.policyIds ?? existing?.policyIds ?? [])).sort(),
    directPermissions: Array.from(new Set(input.directPermissions ?? existing?.directPermissions ?? [])).sort(),
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function seedMockRoles(): RoleDefinition[] {
  return buildSeededMockRoles(nowIso());
}

function ensureMockRoles() {
  const existing = getStoredRoles();
  if (existing) {
    const migrated = existing.map((role) => ({
      ...role,
      compactionWindow: role.compactionWindow ?? null,
      policyIds: role.policyIds ?? [],
      directPermissions: role.directPermissions ?? [],
    }));

    if (JSON.stringify(migrated) !== JSON.stringify(existing)) {
      saveStoredRoles(migrated);
    }

    return migrated;
  }

  const seeded = seedMockRoles();
  saveStoredRoles(seeded);
  return seeded;
}

export async function listRoles(includeArchived = false): Promise<RoleSummary[]> {
  if (!isTauriAvailable()) {
    return ensureMockRoles().filter((role) => includeArchived || !role.archived).map(summarizeRole);
  }

  return invoke<RoleSummary[]>("list_roles", { includeArchived });
}

export async function getRole(roleId: string): Promise<RoleDefinition> {
  if (!isTauriAvailable()) {
    const role = ensureMockRoles().find((entry) => entry.id === roleId);
    if (!role) {
      throw new Error(`Role ${roleId} was not found`);
    }
    return role;
  }

  return invoke<RoleDefinition>("get_role", { roleId });
}

export async function validateRole(input: RoleUpsertInput): Promise<RoleValidationResult> {
  if (!isTauriAvailable()) {
    return buildMockRoleValidation(input);
  }

  return invoke<RoleValidationResult>("validate_role", { input });
}

export async function createRole(input: RoleUpsertInput): Promise<RoleDefinition> {
  if (!isTauriAvailable()) {
    const validation = buildMockRoleValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const role = normalizeMockRoleInput(input);
    saveStoredRoles([role, ...ensureMockRoles()]);
    return role;
  }

  return invoke<RoleDefinition>("create_role", { input });
}

export async function updateRole(roleId: string, input: RoleUpsertInput): Promise<RoleDefinition> {
  if (!isTauriAvailable()) {
    const validation = buildMockRoleValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const roles = ensureMockRoles();
    const existing = roles.find((role) => role.id === roleId);
    if (!existing) {
      throw new Error(`Role ${roleId} was not found`);
    }

    const updated = normalizeMockRoleInput(input, existing);
    saveStoredRoles(roles.map((role) => (role.id === roleId ? updated : role)));
    return updated;
  }

  return invoke<RoleDefinition>("update_role", { roleId, input });
}

export async function archiveRole(roleId: string): Promise<RoleDefinition> {
  if (!isTauriAvailable()) {
    const roles = ensureMockRoles();
    const existing = roles.find((role) => role.id === roleId);
    if (!existing) {
      throw new Error(`Role ${roleId} was not found`);
    }

    const archived: RoleDefinition = {
      ...existing,
      archived: true,
      updatedAt: nowIso(),
    };

    saveStoredRoles(roles.map((role) => (role.id === roleId ? archived : role)));
    return archived;
  }

  return invoke<RoleDefinition>("archive_role", { roleId });
}
