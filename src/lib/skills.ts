import { invoke } from "@tauri-apps/api/core";

import { getActiveOrchestraClientBinding, getHostedWebOrchestraClientBinding } from "./orchestraClient/runtime";
import { isTauriAvailable } from "./mockOrchestra/host";
import type {
  AgentSkillLinks,
  LocalSkillUpsertInput,
  RoleSkillLinks,
  SkillBindingInput,
  SkillDetail,
  SkillSummary,
  SkillsCatalogDiagnostics,
  WorkflowSkillLinks,
} from "../types";

function unsupportedHostError() {
  return new Error("Managed skills are unavailable with the current Orchestra host configuration.");
}

function getSkillsService() {
  return getActiveOrchestraClientBinding()?.client.skills ?? null;
}

function requireLocalTauriBackend() {
  if (getHostedWebOrchestraClientBinding()) {
    throw unsupportedHostError();
  }
  if (!isTauriAvailable()) {
    throw unsupportedHostError();
  }
}

export async function listSkills(includeArchived = false): Promise<SkillSummary[]> {
  const skills = getSkillsService();
  if (skills) {
    return skills.listSkills(includeArchived);
  }
  requireLocalTauriBackend();
  return invoke<SkillSummary[]>("list_skills", { includeArchived });
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.getSkill(skillId);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("get_skill", { skillId });
}

export async function getSkillsCatalogDiagnostics(): Promise<SkillsCatalogDiagnostics> {
  const skills = getSkillsService();
  if (skills) {
    return skills.getCatalogDiagnostics();
  }
  requireLocalTauriBackend();
  return invoke<SkillsCatalogDiagnostics>("get_skills_catalog_diagnostics");
}

export async function createLocalSkill(input: LocalSkillUpsertInput): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.createLocalSkill(input);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("create_local_skill", { input });
}

export async function updateLocalSkill(skillId: string, input: LocalSkillUpsertInput): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.updateLocalSkill(skillId, input);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("update_local_skill", { skillId, input });
}

export async function archiveLocalSkill(skillId: string): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.archiveLocalSkill(skillId);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("archive_local_skill", { skillId });
}

export async function unarchiveLocalSkill(skillId: string): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.unarchiveLocalSkill(skillId);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("unarchive_local_skill", { skillId });
}

export async function deleteLocalSkill(skillId: string): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.deleteLocalSkill(skillId);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("delete_local_skill", { skillId });
}

export async function refreshExternalSkills(): Promise<SkillSummary[]> {
  const skills = getSkillsService();
  if (skills) {
    return skills.refreshExternalSkills();
  }
  requireLocalTauriBackend();
  return invoke<SkillSummary[]>("refresh_external_skills");
}

export async function setSkillBindings(skillId: string, bindings: SkillBindingInput[]): Promise<SkillDetail> {
  const skills = getSkillsService();
  if (skills) {
    return skills.setSkillBindings(skillId, bindings);
  }
  requireLocalTauriBackend();
  return invoke<SkillDetail>("set_skill_bindings", { skillId, bindings });
}

export async function getRoleSkillLinks(roleId: string): Promise<RoleSkillLinks> {
  const skills = getSkillsService();
  if (skills) {
    return skills.getRoleSkillLinks(roleId);
  }
  requireLocalTauriBackend();
  return invoke<RoleSkillLinks>("get_role_skill_links", { roleId });
}

export async function getAgentSkillLinks(agentId: string): Promise<AgentSkillLinks> {
  const skills = getSkillsService();
  if (skills) {
    return skills.getAgentSkillLinks(agentId);
  }
  requireLocalTauriBackend();
  return invoke<AgentSkillLinks>("get_agent_skill_links", { agentId });
}

export async function getWorkflowSkillLinks(workflowId: string): Promise<WorkflowSkillLinks> {
  const skills = getSkillsService();
  if (skills) {
    return skills.getWorkflowSkillLinks(workflowId);
  }
  requireLocalTauriBackend();
  return invoke<WorkflowSkillLinks>("get_workflow_skill_links", { workflowId });
}
