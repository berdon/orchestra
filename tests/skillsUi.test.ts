import { describe, expect, it } from "vitest";

import {
  buildLocalSkillDraftState,
  buildSkillBindingDraft,
  createBlankLocalSkillDraft,
  createBlankSkillBindingDraft,
  deriveSkillDescriptionPreview,
  deriveSkillSlugPreview,
  filterSkillBindingTargets,
  filterSkills,
  normalizeSkillBindingDraftForSave,
  setSkillBindingDraftGlobal,
  skillBindingDraftHasChanges,
  validateSkillBindingDraft,
  validateSkillSlug,
} from "../src/lib/skillsUi";
import type { SkillDetail, SkillSummary } from "../src/types";

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
    runtimeWarnings: overrides.runtimeWarnings ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

function makeSkillDetail(overrides: Partial<SkillDetail>): SkillDetail {
  const summary = makeSkill(overrides);
  return {
    ...summary,
    markdownBody: overrides.markdownBody ?? "# Skill\n\nDetail body.",
    bindingSummary: overrides.bindingSummary ?? { totalCount: 0, scopeCounts: [] },
    bindings: overrides.bindings ?? [],
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
    expect(createBlankSkillBindingDraft()).toEqual({
      global: false,
      projectIds: [],
      roleIds: [],
      agentIds: [],
      workflowIds: [],
      workflowLaneBindings: [],
    });
  });

  it("clears narrower binding scopes when global is enabled", () => {
    const draft = setSkillBindingDraftGlobal({
      global: false,
      projectIds: ["project-1"],
      roleIds: ["role-1"],
      agentIds: ["agent-1"],
      workflowIds: ["workflow-1"],
      workflowLaneBindings: [{ workflowId: "workflow-1", workflowLaneId: "lane-1" }],
    }, true);

    expect(draft).toEqual({
      global: true,
      projectIds: [],
      roleIds: [],
      agentIds: [],
      workflowIds: [],
      workflowLaneBindings: [],
    });
  });

  it("normalizes binding drafts for save and validates partial lane rows", () => {
    expect(normalizeSkillBindingDraftForSave({
      global: false,
      projectIds: ["project-1", "project-1"],
      roleIds: [],
      agentIds: [],
      workflowIds: ["workflow-1"],
      workflowLaneBindings: [
        { workflowId: "workflow-1", workflowLaneId: "lane-1" },
        { workflowId: "workflow-1", workflowLaneId: "lane-1" },
      ],
    })).toEqual([
      { scopeKind: "project", projectId: "project-1", roleId: null, agentId: null, workflowId: null, workflowLaneId: null },
      { scopeKind: "workflow", projectId: null, roleId: null, agentId: null, workflowId: "workflow-1", workflowLaneId: null },
      { scopeKind: "workflow_lane", projectId: null, roleId: null, agentId: null, workflowId: "workflow-1", workflowLaneId: "lane-1" },
    ]);

    expect(validateSkillBindingDraft({
      global: false,
      projectIds: [],
      roleIds: [],
      agentIds: [],
      workflowIds: [],
      workflowLaneBindings: [{ workflowId: "workflow-1", workflowLaneId: "" }],
    })).toEqual(["Lane binding 1 must include both a workflow and lane."]);
  });

  it("builds binding drafts from details and detects dirty assignment state", () => {
    const detail = makeSkillDetail({
      bindings: [
        {
          id: "binding-1",
          skillId: "skill-1",
          scopeKind: "role",
          roleId: "role-1",
          projectId: null,
          agentId: null,
          workflowId: null,
          workflowLaneId: null,
          roleName: "Reviewer",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      bindingSummary: { totalCount: 1, scopeCounts: [{ scopeKind: "role", count: 1 }] },
    });

    const draft = buildSkillBindingDraft(detail);
    expect(draft.roleIds).toEqual(["role-1"]);
    expect(skillBindingDraftHasChanges(draft, detail)).toBe(false);
    expect(skillBindingDraftHasChanges({ ...draft, agentIds: ["agent-1"] }, detail)).toBe(true);
  });

  it("filters searchable binding targets by name or slug", () => {
    const roles = [
      { id: "role-1", name: "Reviewer", slug: "reviewer" },
      { id: "role-2", name: "QA Helper", slug: "qa-helper" },
    ];

    expect(filterSkillBindingTargets(roles, "qa").map((role) => role.id)).toEqual(["role-2"]);
    expect(filterSkillBindingTargets(roles, "review").map((role) => role.id)).toEqual(["role-1"]);
  });
});
