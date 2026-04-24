import { invoke } from "@tauri-apps/api/core";

import { getHostedWebOrchestraClientBinding } from "./orchestraClient/runtime";
import { isTauriAvailable } from "./mockOrchestra/host";
import type {
  AgentSkillLinks,
  LocalSkillUpsertInput,
  RoleSkillLinks,
  SkillBindingInput,
  SkillDetail,
  SkillSummary,
  WorkflowSkillLinks,
} from "../types";

function unsupportedHostError() {
  return new Error("Managed skills are currently available only in the local Tauri backend.");
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
  requireLocalTauriBackend();
  return invoke<SkillSummary[]>("list_skills", { includeArchived });
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("get_skill", { skillId });
}

export async function createLocalSkill(input: LocalSkillUpsertInput): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("create_local_skill", { input });
}

export async function updateLocalSkill(skillId: string, input: LocalSkillUpsertInput): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("update_local_skill", { skillId, input });
}

export async function archiveLocalSkill(skillId: string): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("archive_local_skill", { skillId });
}

export async function unarchiveLocalSkill(skillId: string): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("unarchive_local_skill", { skillId });
}

export async function deleteLocalSkill(skillId: string): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("delete_local_skill", { skillId });
}

export async function refreshExternalSkills(): Promise<SkillSummary[]> {
  requireLocalTauriBackend();
  return invoke<SkillSummary[]>("refresh_external_skills");
}

export async function setSkillBindings(skillId: string, bindings: SkillBindingInput[]): Promise<SkillDetail> {
  requireLocalTauriBackend();
  return invoke<SkillDetail>("set_skill_bindings", { skillId, bindings });
}

export async function getRoleSkillLinks(roleId: string): Promise<RoleSkillLinks> {
  requireLocalTauriBackend();
  return invoke<RoleSkillLinks>("get_role_skill_links", { roleId });
}

export async function getAgentSkillLinks(agentId: string): Promise<AgentSkillLinks> {
  requireLocalTauriBackend();
  return invoke<AgentSkillLinks>("get_agent_skill_links", { agentId });
}

export async function getWorkflowSkillLinks(workflowId: string): Promise<WorkflowSkillLinks> {
  requireLocalTauriBackend();
  return invoke<WorkflowSkillLinks>("get_workflow_skill_links", { workflowId });
}
