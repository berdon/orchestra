import type {
  LocalSkillUpsertInput,
  SkillBindingDraftLaneRow,
  SkillBindingInput,
  SkillBindingScopeKind,
  SkillDetail,
  SkillStatus,
  SkillSummary,
} from "../types";

export type SkillSourceFilter = "all" | "local" | "external";
export type SkillStatusFilter = "all" | "active" | "archived" | "shadowed" | "missing" | "invalid";

export interface SkillCatalogFilters {
  query: string;
  source: SkillSourceFilter;
  status: SkillStatusFilter;
}

export interface LocalSkillDraftState {
  normalizedName: string;
  normalizedSlug: string;
  normalizedMarkdownBody: string;
  slugPreview: string;
  descriptionPreview: string | null;
  validationErrors: {
    name?: string;
    slug?: string;
    markdownBody?: string;
  };
}

export interface SkillBindingDraft {
  global: boolean;
  projectIds: string[];
  roleIds: string[];
  agentIds: string[];
  workflowIds: string[];
  workflowLaneBindings: SkillBindingDraftLaneRow[];
}

export function createBlankLocalSkillDraft(): LocalSkillUpsertInput {
  return {
    name: "",
    slug: "",
    markdownBody: "",
  };
}

export function normalizeSkillMarkdownBody(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sanitizeSkillSlug(value: string) {
  const trimmed = value.trim().toLowerCase();
  let slug = "";
  let lastWasDash = false;

  for (const character of trimmed) {
    if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) {
      slug += character;
      lastWasDash = false;
      continue;
    }

    if (!lastWasDash) {
      slug += "-";
      lastWasDash = true;
    }
  }

  const normalized = slug.replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "project";
}

export function deriveSkillSlugPreview(name: string, explicitSlug: string) {
  const normalizedExplicitSlug = explicitSlug.trim();
  if (normalizedExplicitSlug.length > 0) {
    return normalizedExplicitSlug;
  }

  return name.trim().length > 0 ? sanitizeSkillSlug(name) : "";
}

export function validateSkillSlug(value: string) {
  if (!value) {
    return "Skill slug is required.";
  }

  const segments = value.split("-");
  const valid = segments.every((segment) => segment.length > 0 && /^[a-z0-9]+$/.test(segment));
  if (!valid || value.startsWith("-") || value.endsWith("-")) {
    return "Use lowercase letters, numbers, and single dashes only.";
  }

  return null;
}

function collapseWhitespace(value: string) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

export function deriveSkillDescriptionPreview(markdown: string) {
  const normalized = normalizeSkillMarkdownBody(markdown);
  let inCodeFence = false;
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" "));
        currentParagraph = [];
      }
      continue;
    }

    if (inCodeFence) {
      continue;
    }

    if (!trimmed) {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" "));
        currentParagraph = [];
      }
      continue;
    }

    currentParagraph.push(trimmed);
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  for (const paragraph of paragraphs) {
    const collapsed = collapseWhitespace(paragraph);
    if (!collapsed || collapsed.startsWith("#") || /^-+$/.test(collapsed)) {
      continue;
    }
    return collapsed;
  }

  return null;
}

export function buildLocalSkillDraftState(draft: LocalSkillUpsertInput): LocalSkillDraftState {
  const normalizedName = draft.name.trim();
  const normalizedSlug = draft.slug?.trim() ?? "";
  const normalizedMarkdownBody = normalizeSkillMarkdownBody(draft.markdownBody ?? "");
  const slugPreview = deriveSkillSlugPreview(normalizedName, normalizedSlug);
  const descriptionPreview = deriveSkillDescriptionPreview(normalizedMarkdownBody);
  const validationErrors: LocalSkillDraftState["validationErrors"] = {};

  if (!normalizedName) {
    validationErrors.name = "Skill name is required.";
  }

  if (normalizedSlug) {
    const slugError = validateSkillSlug(normalizedSlug);
    if (slugError) {
      validationErrors.slug = slugError;
    }
  } else if (normalizedName && slugPreview) {
    const derivedSlugError = validateSkillSlug(slugPreview);
    if (derivedSlugError) {
      validationErrors.slug = `Derived slug ${slugPreview} is invalid. Use a different name or provide an explicit slug.`;
    }
  }

  if (!normalizedMarkdownBody.trim()) {
    validationErrors.markdownBody = "Skill markdown body must contain non-empty markdown content.";
  }

  return {
    normalizedName,
    normalizedSlug,
    normalizedMarkdownBody,
    slugPreview,
    descriptionPreview,
    validationErrors,
  };
}

export function normalizeLocalSkillDraftForSave(draft: LocalSkillUpsertInput): LocalSkillUpsertInput {
  const state = buildLocalSkillDraftState(draft);
  return {
    name: state.normalizedName,
    slug: state.normalizedSlug || null,
    markdownBody: state.normalizedMarkdownBody,
  };
}

export function localSkillDraftHasChanges(draft: LocalSkillUpsertInput, detail: SkillDetail | null) {
  if (!detail || detail.sourceKind !== "local") {
    return false;
  }

  const normalizedDraft = normalizeLocalSkillDraftForSave(draft);
  return normalizedDraft.name !== detail.name
    || (normalizedDraft.slug ?? null) !== (detail.slug ?? null)
    || normalizeSkillMarkdownBody(normalizedDraft.markdownBody) !== normalizeSkillMarkdownBody(detail.markdownBody ?? "");
}

export function localSkillDraftHasContent(draft: LocalSkillUpsertInput) {
  return Boolean(draft.name.trim() || draft.slug?.trim() || draft.markdownBody.trim());
}

function normalizeBindingIdList(ids: string[]) {
  return Array.from(new Set(ids.map((value) => value.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function normalizeBindingLaneRows(rows: SkillBindingDraftLaneRow[]) {
  const seen = new Set<string>();
  const normalized: SkillBindingDraftLaneRow[] = [];

  for (const row of rows) {
    const workflowId = row.workflowId.trim();
    const workflowLaneId = row.workflowLaneId.trim();
    if (!workflowId && !workflowLaneId) {
      continue;
    }
    const key = `${workflowId}::${workflowLaneId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ workflowId, workflowLaneId });
  }

  return normalized.sort((left, right) => (
    left.workflowId.localeCompare(right.workflowId) || left.workflowLaneId.localeCompare(right.workflowLaneId)
  ));
}

function normalizeBindingInputs(bindings: SkillBindingInput[]) {
  return bindings
    .map((binding) => ({
      scopeKind: binding.scopeKind,
      projectId: binding.projectId?.trim() || null,
      roleId: binding.roleId?.trim() || null,
      agentId: binding.agentId?.trim() || null,
      workflowId: binding.workflowId?.trim() || null,
      workflowLaneId: binding.workflowLaneId?.trim() || null,
    }))
    .sort((left, right) => {
      const leftRank = bindingScopeOrder(left.scopeKind);
      const rightRank = bindingScopeOrder(right.scopeKind);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return [left.projectId, left.roleId, left.agentId, left.workflowId, left.workflowLaneId].join("|")
        .localeCompare([right.projectId, right.roleId, right.agentId, right.workflowId, right.workflowLaneId].join("|"));
    });
}

function bindingScopeOrder(scopeKind: SkillBindingScopeKind) {
  switch (scopeKind) {
    case "global":
      return 0;
    case "project":
      return 1;
    case "role":
      return 2;
    case "agent":
      return 3;
    case "workflow":
      return 4;
    case "workflow_lane":
      return 5;
    default:
      return 6;
  }
}

export function createBlankSkillBindingDraft(): SkillBindingDraft {
  return {
    global: false,
    projectIds: [],
    roleIds: [],
    agentIds: [],
    workflowIds: [],
    workflowLaneBindings: [],
  };
}

export function setSkillBindingDraftGlobal(draft: SkillBindingDraft, enabled: boolean): SkillBindingDraft {
  if (!enabled) {
    return {
      ...draft,
      global: false,
    };
  }

  return {
    global: true,
    projectIds: [],
    roleIds: [],
    agentIds: [],
    workflowIds: [],
    workflowLaneBindings: [],
  };
}

export function buildSkillBindingDraft(detail: SkillDetail | null): SkillBindingDraft {
  if (!detail) {
    return createBlankSkillBindingDraft();
  }

  const draft = createBlankSkillBindingDraft();
  for (const binding of detail.bindings) {
    switch (binding.scopeKind) {
      case "global":
        return setSkillBindingDraftGlobal(draft, true);
      case "project":
        if (binding.projectId) {
          draft.projectIds.push(binding.projectId);
        }
        break;
      case "role":
        if (binding.roleId) {
          draft.roleIds.push(binding.roleId);
        }
        break;
      case "agent":
        if (binding.agentId) {
          draft.agentIds.push(binding.agentId);
        }
        break;
      case "workflow":
        if (binding.workflowId) {
          draft.workflowIds.push(binding.workflowId);
        }
        break;
      case "workflow_lane":
        draft.workflowLaneBindings.push({
          workflowId: binding.workflowId ?? "",
          workflowLaneId: binding.workflowLaneId ?? "",
        });
        break;
      default:
        break;
    }
  }

  return {
    global: false,
    projectIds: normalizeBindingIdList(draft.projectIds),
    roleIds: normalizeBindingIdList(draft.roleIds),
    agentIds: normalizeBindingIdList(draft.agentIds),
    workflowIds: normalizeBindingIdList(draft.workflowIds),
    workflowLaneBindings: normalizeBindingLaneRows(draft.workflowLaneBindings),
  };
}

export function validateSkillBindingDraft(draft: SkillBindingDraft) {
  if (draft.global) {
    return [] as string[];
  }

  const errors: string[] = [];
  for (const [index, row] of draft.workflowLaneBindings.entries()) {
    const workflowId = row.workflowId.trim();
    const workflowLaneId = row.workflowLaneId.trim();
    if (!workflowId && !workflowLaneId) {
      continue;
    }
    if (!workflowId || !workflowLaneId) {
      errors.push(`Lane binding ${index + 1} must include both a workflow and lane.`);
    }
  }

  return errors;
}

export function normalizeSkillBindingDraftForSave(draft: SkillBindingDraft): SkillBindingInput[] {
  if (draft.global) {
    return [{ scopeKind: "global" }];
  }

  return normalizeBindingInputs([
    ...normalizeBindingIdList(draft.projectIds).map((projectId) => ({ scopeKind: "project" as const, projectId })),
    ...normalizeBindingIdList(draft.roleIds).map((roleId) => ({ scopeKind: "role" as const, roleId })),
    ...normalizeBindingIdList(draft.agentIds).map((agentId) => ({ scopeKind: "agent" as const, agentId })),
    ...normalizeBindingIdList(draft.workflowIds).map((workflowId) => ({ scopeKind: "workflow" as const, workflowId })),
    ...normalizeBindingLaneRows(draft.workflowLaneBindings)
      .filter((row) => row.workflowId && row.workflowLaneId)
      .map((row) => ({
        scopeKind: "workflow_lane" as const,
        workflowId: row.workflowId,
        workflowLaneId: row.workflowLaneId,
      })),
  ]);
}

export function skillBindingDraftHasChanges(draft: SkillBindingDraft, detail: SkillDetail | null) {
  if (!detail) {
    return false;
  }

  return JSON.stringify(normalizeSkillBindingDraftForSave(draft))
    !== JSON.stringify(normalizeBindingInputs(detail.bindings.map((binding) => ({
      scopeKind: binding.scopeKind,
      projectId: binding.projectId,
      roleId: binding.roleId,
      agentId: binding.agentId,
      workflowId: binding.workflowId,
      workflowLaneId: binding.workflowLaneId,
    }))));
}

export function filterSkillBindingTargets<T extends { name: string; slug?: string | null }>(entries: T[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => `${entry.name}\n${entry.slug ?? ""}`.toLowerCase().includes(normalizedQuery));
}

function matchesStatusFilter(skill: SkillSummary, statusFilter: SkillStatusFilter) {
  if (statusFilter === "all") {
    return true;
  }

  if (statusFilter === "archived") {
    return skill.archived;
  }

  if (skill.archived) {
    return false;
  }

  if (statusFilter === "invalid") {
    return skill.status === "invalid" || skill.status === "unloadable";
  }

  return skill.status === statusFilter;
}

function matchesSourceFilter(skill: SkillSummary, sourceFilter: SkillSourceFilter) {
  if (sourceFilter === "all") {
    return true;
  }

  return skill.sourceKind === sourceFilter;
}

function includesQuery(skill: SkillSummary, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    skill.name,
    skill.slug ?? "",
    skill.description ?? "",
    skill.relativeSourcePath ?? "",
    skill.sourcePath,
  ].join("\n").toLowerCase();

  return haystack.includes(normalizedQuery);
}

export function filterSkills(skills: SkillSummary[], filters: SkillCatalogFilters) {
  return skills.filter((skill) => (
    includesQuery(skill, filters.query)
    && matchesSourceFilter(skill, filters.source)
    && matchesStatusFilter(skill, filters.status)
  ));
}

export function getSkillStatusFilterLabel(status: SkillStatus) {
  if (status === "unloadable") {
    return "invalid";
  }
  return status;
}
