import { describe, expect, it } from "vitest";

import {
  buildLocalSkillDraftState,
  createBlankLocalSkillDraft,
  deriveSkillDescriptionPreview,
  deriveSkillSlugPreview,
  filterSkills,
  validateSkillSlug,
} from "../src/lib/skillsUi";
import type { SkillSummary } from "../src/types";

function makeSkill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: overrides.id ?? "skill-1",
    slug: overrides.slug ?? "alpha-skill",
    name: overrides.name ?? "Alpha Skill",
    description: overrides.description ?? "First paragraph",
    sourceKind: overrides.sourceKind ?? "local",
    sourcePath: overrides.sourcePath ?? "/tmp/alpha-skill.md",
    contentPath: overrides.contentPath ?? "/tmp/alpha-skill.md",
    relativeSourcePath: overrides.relativeSourcePath ?? null,
    archived: overrides.archived ?? false,
    status: overrides.status ?? "active",
    statusReason: overrides.statusReason ?? null,
    shadowedBySkillId: overrides.shadowedBySkillId ?? null,
    lastSeenAt: overrides.lastSeenAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

describe("skillsUi helpers", () => {
  it("derives a description preview from the first non-heading paragraph outside code fences", () => {
    const markdown = [
      "# Heading",
      "",
      "```md",
      "ignored paragraph",
      "```",
      "",
      "First real paragraph with  extra spacing.",
      "",
      "Second paragraph.",
    ].join("\n");

    expect(deriveSkillDescriptionPreview(markdown)).toBe("First real paragraph with extra spacing.");
  });

  it("derives and validates phase-1 slugs", () => {
    expect(deriveSkillSlugPreview("QA / Reviewer Role", "")).toBe("qa-reviewer-role");
    expect(validateSkillSlug("valid-skill-1")).toBeNull();
    expect(validateSkillSlug("Bad Skill")).toBe("Use lowercase letters, numbers, and single dashes only.");
  });

  it("builds local draft validation and preview state", () => {
    const state = buildLocalSkillDraftState({
      name: "  External Helper  ",
      slug: "",
      markdownBody: "# Title\n\nHelpful first paragraph.\n",
    });

    expect(state.normalizedName).toBe("External Helper");
    expect(state.slugPreview).toBe("external-helper");
    expect(state.descriptionPreview).toBe("Helpful first paragraph.");
    expect(state.validationErrors).toEqual({});
  });

  it("matches archived and invalid filter buckets across local and external skills", () => {
    const skills = [
      makeSkill({ id: "skill-local", name: "Local Skill", sourceKind: "local", status: "active" }),
      makeSkill({ id: "skill-archived", name: "Archived Skill", archived: true, status: "active" }),
      makeSkill({ id: "skill-invalid", name: "Broken External", sourceKind: "external", status: "invalid", relativeSourcePath: "broken/skill" }),
      makeSkill({ id: "skill-unloadable", name: "Unreadable External", sourceKind: "external", status: "unloadable", relativeSourcePath: "unreadable/skill" }),
    ];

    expect(filterSkills(skills, { query: "", source: "all", status: "archived" }).map((skill) => skill.id)).toEqual(["skill-archived"]);
    expect(filterSkills(skills, { query: "", source: "external", status: "invalid" }).map((skill) => skill.id)).toEqual(["skill-invalid", "skill-unloadable"]);
    expect(filterSkills(skills, { query: "broken", source: "external", status: "all" }).map((skill) => skill.id)).toEqual(["skill-invalid"]);
  });

  it("starts new drafts empty", () => {
    expect(createBlankLocalSkillDraft()).toEqual({
      name: "",
      slug: "",
      markdownBody: "",
    });
  });
});
