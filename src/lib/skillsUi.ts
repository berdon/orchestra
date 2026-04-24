import type { LocalSkillUpsertInput, SkillDetail, SkillStatus, SkillSummary } from "../types";

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
