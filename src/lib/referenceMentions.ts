import { fuzzySearch, type FuzzySearchCandidate } from "./fuzzy";
import type { AgentSummary, RoleSummary, TaskFileReference, TaskSummary } from "../types";

export interface ComposerAutocompleteCandidate {
  id: string;
  insertText: string;
  label: string;
  detail?: string;
}

export interface ProjectReferenceContext {
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
}

export interface ProjectMentionLink {
  kind: "task" | "agent" | "role";
  label: string;
  taskId?: string;
  agentId?: string;
  roleId?: string;
}

export interface FileMentionLink {
  label: string;
  reference: TaskFileReference;
}

interface SearchableAutocompleteCandidate extends ComposerAutocompleteCandidate, FuzzySearchCandidate {}

function normalizeToken(token: string) {
  return token.trim().toLowerCase();
}

function buildTaskMentionLabel(task: TaskSummary) {
  return `${task.number} ${task.title}`.trim();
}

function buildAutocompleteItems({ tasks, agents, roles }: ProjectReferenceContext): SearchableAutocompleteCandidate[] {
  return [
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      label: buildTaskMentionLabel(task),
      detail: "Task",
      insertText: `@${task.number}`,
      keywords: [task.number, task.title, task.status, task.priority, task.type],
    })),
    ...agents.map((agent) => ({
      id: `agent:${agent.id}`,
      label: agent.name,
      detail: `Agent · ${agent.slug}`,
      insertText: `@${agent.slug}`,
      keywords: [agent.slug, agent.name],
    })),
    ...roles.map((role) => ({
      id: `role:${role.id}`,
      label: role.name,
      detail: `Role · ${role.slug}`,
      insertText: `@${role.slug}`,
      keywords: [role.slug, role.name],
    })),
  ];
}

export function searchProjectReferenceAutocompleteCandidates(
  query: string,
  context: ProjectReferenceContext,
  limit = 12,
): ComposerAutocompleteCandidate[] {
  const items = buildAutocompleteItems(context);
  return fuzzySearch(query, items, limit).map(({ item }) => ({
    id: item.id,
    insertText: item.insertText,
    label: item.label,
    detail: item.detail,
  }));
}

export function buildProjectMentionLookup({ tasks, agents, roles }: ProjectReferenceContext) {
  const lookup = new Map<string, ProjectMentionLink>();

  for (const task of tasks) {
    lookup.set(normalizeToken(`@${task.number}`), {
      kind: "task",
      label: buildTaskMentionLabel(task),
      taskId: task.id,
    });
  }

  for (const agent of agents) {
    lookup.set(normalizeToken(`@${agent.slug}`), {
      kind: "agent",
      label: agent.name,
      agentId: agent.id,
    });
  }

  for (const role of roles) {
    lookup.set(normalizeToken(`@${role.slug}`), {
      kind: "role",
      label: role.name,
      roleId: role.id,
    });
  }

  return lookup;
}

export function buildTaskFileMentionLookup(fileReferences: TaskFileReference[]) {
  const lookup = new Map<string, FileMentionLink>();
  const relativePathCounts = new Map<string, number>();

  for (const reference of fileReferences) {
    const key = normalizeToken(reference.relativePath);
    relativePathCounts.set(key, (relativePathCounts.get(key) ?? 0) + 1);
  }

  for (const reference of fileReferences) {
    const relativePathKey = normalizeToken(reference.relativePath);
    const bareLabel = reference.relativePath;
    const scopedLabel = `${reference.repositorySlug}:${reference.relativePath}`;
    const entry = {
      reference,
      label: (relativePathCounts.get(relativePathKey) ?? 0) > 1 ? scopedLabel : bareLabel,
    };

    lookup.set(normalizeToken(`$${reference.repositorySlug}:${reference.relativePath}`), {
      reference,
      label: scopedLabel,
    });
    lookup.set(normalizeToken(`@${reference.repositorySlug}:${reference.relativePath}`), {
      reference,
      label: scopedLabel,
    });

    if ((relativePathCounts.get(relativePathKey) ?? 0) === 1) {
      lookup.set(normalizeToken(`$${reference.relativePath}`), entry);
      lookup.set(normalizeToken(`@${reference.relativePath}`), entry);
    }
  }

  return lookup;
}
