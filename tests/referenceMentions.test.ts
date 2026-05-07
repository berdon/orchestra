import { describe, expect, it } from "vitest";

import { buildProjectMentionLookup, buildTaskFileMentionLookup, searchProjectReferenceAutocompleteCandidates } from "../src/lib/referenceMentions";
import type { AgentSummary, RoleSummary, TaskFileReference, TaskSummary } from "../src/types";

const timestamp = new Date().toISOString();

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: overrides.id ?? "task-1",
    projectId: "project-1",
    number: overrides.number ?? "ORC-1",
    title: overrides.title ?? "Ship mention autocomplete",
    description: overrides.description ?? null,
    type: overrides.type ?? "task",
    tags: overrides.tags ?? [],
    status: overrides.status ?? "ready",
    priority: overrides.priority ?? "P2",
    workflowId: overrides.workflowId ?? null,
    currentLaneId: overrides.currentLaneId ?? null,
    assigneeType: overrides.assigneeType ?? "unassigned",
    assigneeId: overrides.assigneeId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    archived: overrides.archived ?? false,
    commentCount: overrides.commentCount ?? 0,
    unreadCommentCount: overrides.unreadCommentCount ?? 0,
    laneRunCount: overrides.laneRunCount ?? 0,
    childCount: overrides.childCount ?? 0,
    completedChildCount: overrides.completedChildCount ?? 0,
    inProgressChildCount: overrides.inProgressChildCount ?? 0,
    blockedChildCount: overrides.blockedChildCount ?? 0,
    blockedByCount: overrides.blockedByCount ?? 0,
    blockingCount: overrides.blockingCount ?? 0,
    attachmentCount: overrides.attachmentCount ?? 0,
    dependencyBlocked: overrides.dependencyBlocked ?? false,
    activeLaneAssignmentStatus: overrides.activeLaneAssignmentStatus ?? null,
    readyForDispatch: overrides.readyForDispatch ?? false,
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: overrides.id ?? "agent-1",
    slug: overrides.slug ?? "supervisor",
    name: overrides.name ?? "Supervisor",
    roleId: overrides.roleId ?? null,
    scope: overrides.scope ?? "project",
    projectId: overrides.projectId ?? "project-1",
    thinkingLevel: overrides.thinkingLevel ?? "medium",
    policyIds: overrides.policyIds ?? [],
    directPermissions: overrides.directPermissions ?? [],
    system: overrides.system ?? false,
    immutable: overrides.immutable ?? false,
    archived: overrides.archived ?? false,
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function makeRole(overrides: Partial<RoleSummary> = {}): RoleSummary {
  return {
    id: overrides.id ?? "role-1",
    slug: overrides.slug ?? "reviewer",
    name: overrides.name ?? "Reviewer",
    description: overrides.description ?? null,
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    thinkingLevel: overrides.thinkingLevel ?? "medium",
    capacity: overrides.capacity ?? 1,
    policyIds: overrides.policyIds ?? [],
    directPermissions: overrides.directPermissions ?? [],
    archived: overrides.archived ?? false,
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function makeFileReference(overrides: Partial<TaskFileReference> = {}): TaskFileReference {
  return {
    id: overrides.id ?? "file-1",
    taskId: overrides.taskId ?? "task-1",
    repositoryId: overrides.repositoryId ?? "repo-1",
    repositoryName: overrides.repositoryName ?? "Repo",
    repositorySlug: overrides.repositorySlug ?? "repo",
    relativePath: overrides.relativePath ?? "docs/design.md",
    absolutePath: overrides.absolutePath ?? null,
    exists: overrides.exists ?? true,
    isDefault: overrides.isDefault ?? false,
    createdAt: overrides.createdAt ?? timestamp,
  };
}

describe("referenceMentions", () => {
  it("prefers task numbers while still matching task titles, agent slugs, and role names", () => {
    const candidates = searchProjectReferenceAutocompleteCandidates("orc", {
      tasks: [makeTask({ title: "Mention autocomplete work" })],
      agents: [makeAgent()],
      roles: [makeRole()],
    });

    expect(candidates[0]?.insertText).toBe("@ORC-1");
    expect(candidates[0]?.label).toBe("ORC-1 Mention autocomplete work");

    const agentCandidates = searchProjectReferenceAutocompleteCandidates("super", {
      tasks: [],
      agents: [makeAgent()],
      roles: [makeRole()],
    });
    expect(agentCandidates[0]?.insertText).toBe("@supervisor");

    const roleCandidates = searchProjectReferenceAutocompleteCandidates("review", {
      tasks: [],
      agents: [],
      roles: [makeRole()],
    });
    expect(roleCandidates[0]?.insertText).toBe("@reviewer");
  });

  it("matches exact slug queries while keeping inserted mentions canonical", () => {
    const candidates = searchProjectReferenceAutocompleteCandidates("fix-task-slug-autocomplete", {
      tasks: [
        makeTask({ id: "task-253", number: "ORC-253", title: "Fix task slug autocomplete" }),
        makeTask({ id: "task-254", number: "ORC-254", title: "Different task" }),
      ],
      agents: [],
      roles: [],
    });

    expect(candidates[0]).toMatchObject({
      id: "task:task-253",
      insertText: "@ORC-253",
      label: "ORC-253 Fix task slug autocomplete",
      detail: "Task",
    });
  });

  it("prefers exact and prefix task-number matches before broader suffix matches", () => {
    const candidates = searchProjectReferenceAutocompleteCandidates("253", {
      tasks: [
        makeTask({ id: "task-253", number: "ORC-253", title: "Exact number task" }),
        makeTask({ id: "task-2530", number: "ORC-2530", title: "Prefix number task" }),
      ],
      agents: [],
      roles: [],
    });

    expect(candidates.map((candidate) => candidate.insertText)).toEqual(["@ORC-253", "@ORC-2530"]);
  });

  it("returns all precise slug-prefix task matches even when they exceed the fallback limit", () => {
    const tasks = Array.from({ length: 13 }, (_, index) => makeTask({
      id: `task-${index + 1}`,
      number: `ORC-${index + 1}`,
      title: `Fix task slug autocomplete case ${index + 1}`,
    }));

    const candidates = searchProjectReferenceAutocompleteCandidates("fix-task-slug-autocomplete", {
      tasks,
      agents: [],
      roles: [],
    }, 12);

    expect(candidates).toHaveLength(13);
    expect(candidates.every((candidate) => candidate.insertText.startsWith("@ORC-"))).toBe(true);
    expect(candidates.map((candidate) => candidate.label)).toEqual(
      tasks
        .map((task) => `${task.number} ${task.title}`)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it("builds rich lookup labels for project mentions", () => {
    const lookup = buildProjectMentionLookup({
      tasks: [makeTask({ id: "task-2", number: "ORC-2", title: "Link task mentions" })],
      agents: [makeAgent({ id: "agent-2", slug: "data", name: "Data" })],
      roles: [makeRole({ id: "role-2", slug: "qa", name: "QA" })],
    });

    expect(lookup.get("@orc-2")).toMatchObject({ kind: "task", label: "ORC-2 Link task mentions", taskId: "task-2" });
    expect(lookup.get("@data")).toMatchObject({ kind: "agent", label: "Data", agentId: "agent-2" });
    expect(lookup.get("@qa")).toMatchObject({ kind: "role", label: "QA", roleId: "role-2" });
  });

  it("supports $ file references while preserving legacy @ file link resolution", () => {
    const lookup = buildTaskFileMentionLookup([
      makeFileReference({ id: "file-1", repositorySlug: "app", relativePath: "docs/design.md" }),
      makeFileReference({ id: "file-2", repositoryId: "repo-2", repositoryName: "Docs", repositorySlug: "docs", relativePath: "docs/design.md" }),
    ]);

    expect(lookup.get("$app:docs/design.md")?.label).toBe("app:docs/design.md");
    expect(lookup.get("@docs:docs/design.md")?.label).toBe("docs:docs/design.md");
    expect(lookup.get("$docs/design.md")).toBeUndefined();
  });
});
