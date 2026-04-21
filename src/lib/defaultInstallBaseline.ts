import baselineCatalogJson from "../seed/default-install-baseline.json";

import type { ProjectDetail, RoleDefinition, WorkflowDefinition, WorkflowLane } from "../types";

type DefaultInstallBaselineCatalog = {
  version: number;
  project: {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
  };
  roles: Array<{
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    provider?: string | null;
    model?: string | null;
    thinkingLevel: string;
    capacity: number;
    directPermissions?: string[];
  }>;
  workflows: Array<{
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    lanes: Array<{
      id: string;
      key: string;
      name: string;
      description?: string | null;
      order: number;
      assignedEntityType: string;
      assignedEntityId?: string | null;
      entryPromptTemplate?: string | null;
      useSeparateWorktree?: boolean;
      requireUserApprovalOnSuccess?: boolean;
      successTransitionType: string;
      successTargetLaneId?: string | null;
      failureTransitionType: string;
      failureTargetLaneId?: string | null;
    }>;
  }>;
};

const baselineCatalog = baselineCatalogJson as DefaultInstallBaselineCatalog;

export const DEFAULT_INSTALL_BASELINE_VERSION = baselineCatalog.version;
export const DEFAULT_INSTALL_BASELINE_PROJECT_ID = baselineCatalog.project.id;
export const DEFAULT_INSTALL_BASELINE_PROJECT_SLUG = baselineCatalog.project.slug;

function cloneLane(lane: DefaultInstallBaselineCatalog["workflows"][number]["lanes"][number]): WorkflowLane {
  return {
    id: lane.id,
    key: lane.key,
    name: lane.name,
    description: lane.description ?? null,
    order: lane.order,
    assignedEntityType: lane.assignedEntityType,
    assignedEntityId: lane.assignedEntityId ?? null,
    entryPromptTemplate: lane.entryPromptTemplate ?? null,
    useSeparateWorktree: Boolean(lane.useSeparateWorktree),
    requireUserApprovalOnSuccess: Boolean(lane.requireUserApprovalOnSuccess),
    successTransitionType: lane.successTransitionType,
    successTargetLaneId: lane.successTargetLaneId ?? null,
    failureTransitionType: lane.failureTransitionType,
    failureTargetLaneId: lane.failureTargetLaneId ?? null,
  };
}

export function buildSeededMockProjects(timestamp = new Date().toISOString()): ProjectDetail[] {
  return [
    {
      id: baselineCatalog.project.id,
      slug: baselineCatalog.project.slug,
      name: baselineCatalog.project.name,
      description: baselineCatalog.project.description ?? null,
      defaultRepositoryId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      repositories: [],
    },
  ];
}

export function buildSeededMockRoles(timestamp = new Date().toISOString()): RoleDefinition[] {
  return baselineCatalog.roles.map((role) => ({
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description ?? null,
    systemPrompt: role.systemPrompt ?? null,
    provider: role.provider ?? null,
    model: role.model ?? null,
    thinkingLevel: role.thinkingLevel,
    capacity: role.capacity,
    policyIds: [],
    directPermissions: [...(role.directPermissions ?? [])],
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

export function buildSeededMockWorkflows(timestamp = new Date().toISOString()): WorkflowDefinition[] {
  return baselineCatalog.workflows.map((workflow) => ({
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description ?? null,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lanes: workflow.lanes.map(cloneLane),
  }));
}

export function getDefaultInstallBaselineCatalog() {
  return baselineCatalog;
}
