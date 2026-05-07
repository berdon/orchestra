import { fuzzyScore, fuzzySearch, type FuzzySearchCandidate } from "./fuzzy";
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

interface TaskAutocompleteCandidate extends SearchableAutocompleteCandidate {
  taskNumberKey: string;
  taskNumberSuffixKey: string | null;
  taskTitleKey: string;
  taskSlugKey: string;
}

function normalizeToken(token: string) {
  return token.trim().toLowerCase();
}

function slugifyTaskTitle(title: string) {
  return normalizeToken(title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getTaskNumberSuffix(taskNumber: string) {
  const segments = normalizeToken(taskNumber).split("-").filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : null;
}

function buildTaskMentionLabel(task: TaskSummary) {
  return `${task.number} ${task.title}`.trim();
}

function buildTaskAutocompleteItem(task: TaskSummary): TaskAutocompleteCandidate {
  const taskNumberKey = normalizeToken(task.number);
  const taskNumberSuffixKey = getTaskNumberSuffix(task.number);
  const taskTitleKey = normalizeToken(task.title);
  const taskSlugKey = slugifyTaskTitle(task.title);

  return {
    id: `task:${task.id}`,
    label: buildTaskMentionLabel(task),
    detail: "Task",
    insertText: `@${task.number}`,
    keywords: [task.number, taskNumberSuffixKey ?? "", task.title, taskSlugKey, task.status, task.priority, task.type],
    taskNumberKey,
    taskNumberSuffixKey,
    taskTitleKey,
    taskSlugKey,
  };
}

function buildNonTaskAutocompleteItems({ agents, roles }: Omit<ProjectReferenceContext, "tasks">): SearchableAutocompleteCandidate[] {
  return [
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

function mapAutocompleteCandidate(item: SearchableAutocompleteCandidate): ComposerAutocompleteCandidate {
  return {
    id: item.id,
    insertText: item.insertText,
    label: item.label,
    detail: item.detail,
  };
}

function getTitleMatchRank(query: string, title: string) {
  if (title === query) {
    return 0;
  }

  if (title.startsWith(query)) {
    return 1;
  }

  if (title.includes(` ${query}`)) {
    return 2;
  }

  if (title.includes(query)) {
    return 3;
  }

  return 4;
}

function getPreciseTaskMatchRank(query: string, item: TaskAutocompleteCandidate) {
  if (item.taskNumberKey === query) {
    return 0;
  }

  if (item.taskNumberSuffixKey === query) {
    return 1;
  }

  if (item.taskSlugKey === query) {
    return 2;
  }

  if (item.taskNumberKey.startsWith(query)) {
    return 3;
  }

  if (item.taskNumberSuffixKey?.startsWith(query)) {
    return 4;
  }

  if (item.taskSlugKey.startsWith(query)) {
    return 5;
  }

  return null;
}

function searchTaskAutocompleteCandidates(query: string, tasks: TaskSummary[], limit: number) {
  const items = tasks.map(buildTaskAutocompleteItem);
  if (!query) {
    return items.slice(0, limit).map(mapAutocompleteCandidate);
  }

  const preciseMatches: Array<{ item: TaskAutocompleteCandidate; rank: number }> = [];
  const fallbackMatches: Array<{ item: TaskAutocompleteCandidate; rank: number; fuzzy: number }> = [];

  for (const item of items) {
    const preciseRank = getPreciseTaskMatchRank(query, item);
    if (preciseRank !== null) {
      preciseMatches.push({ item, rank: preciseRank });
      continue;
    }

    const fuzzy = fuzzyScore(query, item);
    if (fuzzy < 0) {
      continue;
    }

    fallbackMatches.push({
      item,
      rank: getTitleMatchRank(query, item.taskTitleKey),
      fuzzy,
    });
  }

  preciseMatches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return left.item.label.localeCompare(right.item.label);
  });

  fallbackMatches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (right.fuzzy !== left.fuzzy) {
      return right.fuzzy - left.fuzzy;
    }
    return left.item.label.localeCompare(right.item.label);
  });

  return [
    ...preciseMatches.map(({ item }) => mapAutocompleteCandidate(item)),
    ...fallbackMatches.slice(0, limit).map(({ item }) => mapAutocompleteCandidate(item)),
  ];
}

export function searchProjectReferenceAutocompleteCandidates(
  query: string,
  context: ProjectReferenceContext,
  limit = 12,
): ComposerAutocompleteCandidate[] {
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) {
    return [
      ...context.tasks.map(buildTaskAutocompleteItem),
      ...buildNonTaskAutocompleteItems(context),
    ].slice(0, limit).map(mapAutocompleteCandidate);
  }

  const taskMatches = searchTaskAutocompleteCandidates(normalizedQuery, context.tasks, limit);
  const otherMatches = fuzzySearch(normalizedQuery, buildNonTaskAutocompleteItems(context), limit).map(({ item }) => mapAutocompleteCandidate(item));
  return [...taskMatches, ...otherMatches];
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
