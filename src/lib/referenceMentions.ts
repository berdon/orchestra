import { fuzzyScore, fuzzySearch, type FuzzySearchCandidate } from "./fuzzy";
import { normalizeTaskTags } from "./taskTags";
import type { AgentSummary, ProjectSummary, RoleSummary, TaskCommentFileMentionCandidate, TaskFileReference, TaskSummary } from "../types";

export interface ComposerAutocompleteCandidate {
  id: string;
  insertText: string;
  label: string;
  detail?: string;
}

export interface ProjectReferenceContext {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
}

export interface ProjectMentionLink {
  kind: "project" | "task" | "agent" | "role";
  label: string;
  projectId?: string;
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

interface SearchableTagAutocompleteCandidate extends SearchableAutocompleteCandidate {
  normalizedTag: string;
}

interface ProjectAutocompleteCandidate extends SearchableAutocompleteCandidate {
  projectSlugKey: string;
  projectPrefixKey: string;
  projectNameKey: string;
}

function normalizeToken(token: string) {
  return token.trim().toLowerCase();
}

function compareAutocompleteStrings(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
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

function buildProjectMentionLabel(project: ProjectSummary) {
  return project.name.trim() || project.slug;
}

function buildTaskMentionLabel(task: TaskSummary) {
  return `${task.number} ${task.title}`.trim();
}

function buildProjectAutocompleteItem(project: ProjectSummary): ProjectAutocompleteCandidate {
  return {
    id: `project:${project.id}`,
    label: buildProjectMentionLabel(project),
    detail: `Project · ${project.slug} · ${project.taskPrefix}`,
    insertText: `@${project.slug}`,
    keywords: [project.slug, project.name, project.taskPrefix],
    projectSlugKey: normalizeToken(project.slug),
    projectPrefixKey: normalizeToken(project.taskPrefix),
    projectNameKey: normalizeToken(project.name),
  };
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

function buildNonTaskAutocompleteItems({ agents, roles }: Omit<ProjectReferenceContext, "projects" | "tasks">): SearchableAutocompleteCandidate[] {
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

function buildProjectTagAutocompleteItems(tasks: TaskSummary[], prioritizedTags: Iterable<string | null | undefined> = []): SearchableTagAutocompleteCandidate[] {
  const normalizedPrioritizedTags = normalizeTaskTags(prioritizedTags);
  const prioritizedTagSet = new Set(normalizedPrioritizedTags);
  const normalizedProjectTags = normalizeTaskTags(tasks.flatMap((task) => task.tags ?? []));
  const orderedTags = [
    ...normalizedPrioritizedTags,
    ...normalizedProjectTags.filter((tag) => !prioritizedTagSet.has(tag)),
  ];

  return orderedTags.map((tag) => ({
    id: `tag:${tag}`,
    normalizedTag: tag,
    label: `#${tag}`,
    detail: "Tag",
    insertText: `#${tag}`,
    keywords: [tag, `#${tag}`],
  }));
}

function mapAutocompleteCandidate(item: SearchableAutocompleteCandidate): ComposerAutocompleteCandidate {
  return {
    id: item.id,
    insertText: item.insertText,
    label: item.label,
    detail: item.detail,
  };
}

function compareProjectAutocompleteItems(left: ProjectAutocompleteCandidate, right: ProjectAutocompleteCandidate) {
  const prefixComparison = compareAutocompleteStrings(left.projectPrefixKey, right.projectPrefixKey);
  if (prefixComparison !== 0) {
    return prefixComparison;
  }

  const nameComparison = compareAutocompleteStrings(left.label, right.label);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return compareAutocompleteStrings(left.id, right.id);
}

function compareTaskAutocompleteItems(left: TaskAutocompleteCandidate, right: TaskAutocompleteCandidate) {
  const numberComparison = compareAutocompleteStrings(left.taskNumberKey, right.taskNumberKey);
  if (numberComparison !== 0) {
    return numberComparison;
  }

  const titleComparison = compareAutocompleteStrings(left.taskTitleKey, right.taskTitleKey);
  if (titleComparison !== 0) {
    return titleComparison;
  }

  return compareAutocompleteStrings(left.id, right.id);
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

function getPreciseProjectMatchRank(query: string, item: ProjectAutocompleteCandidate) {
  if (item.projectPrefixKey === query) {
    return 0;
  }

  if (item.projectSlugKey === query) {
    return 1;
  }

  if (item.projectNameKey === query) {
    return 2;
  }

  if (item.projectPrefixKey.startsWith(query)) {
    return 3;
  }

  if (item.projectSlugKey.startsWith(query)) {
    return 4;
  }

  if (item.projectNameKey.startsWith(query)) {
    return 5;
  }

  return null;
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

function searchProjectAutocompleteCandidates(query: string, projects: ProjectSummary[], limit: number) {
  const items = projects.map(buildProjectAutocompleteItem);
  if (!query) {
    return items.sort(compareProjectAutocompleteItems).slice(0, limit).map(mapAutocompleteCandidate);
  }

  if (query.includes("-")) {
    return [];
  }

  const preciseMatches: Array<{ item: ProjectAutocompleteCandidate; rank: number }> = [];
  const fallbackMatches: Array<{ item: ProjectAutocompleteCandidate; rank: number; fuzzy: number }> = [];

  for (const item of items) {
    const preciseRank = getPreciseProjectMatchRank(query, item);
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
      rank: getTitleMatchRank(query, item.projectNameKey),
      fuzzy,
    });
  }

  preciseMatches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return compareProjectAutocompleteItems(left.item, right.item);
  });

  fallbackMatches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (right.fuzzy !== left.fuzzy) {
      return right.fuzzy - left.fuzzy;
    }
    return compareProjectAutocompleteItems(left.item, right.item);
  });

  return [
    ...preciseMatches.map(({ item }) => mapAutocompleteCandidate(item)),
    ...fallbackMatches.slice(0, limit).map(({ item }) => mapAutocompleteCandidate(item)),
  ];
}

function searchTaskAutocompleteCandidates(query: string, tasks: TaskSummary[], limit: number) {
  const items = tasks.map(buildTaskAutocompleteItem);
  if (!query) {
    return items.sort(compareTaskAutocompleteItems).slice(0, limit).map(mapAutocompleteCandidate);
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
    return compareTaskAutocompleteItems(left.item, right.item);
  });

  fallbackMatches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (right.fuzzy !== left.fuzzy) {
      return right.fuzzy - left.fuzzy;
    }
    return compareTaskAutocompleteItems(left.item, right.item);
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
      ...context.projects.map(buildProjectAutocompleteItem).sort(compareProjectAutocompleteItems),
      ...context.tasks.map(buildTaskAutocompleteItem).sort(compareTaskAutocompleteItems),
      ...buildNonTaskAutocompleteItems(context),
    ].slice(0, limit).map(mapAutocompleteCandidate);
  }

  const projectMatches = searchProjectAutocompleteCandidates(normalizedQuery, context.projects, limit);
  const taskMatches = searchTaskAutocompleteCandidates(normalizedQuery, context.tasks, limit);
  const otherMatches = fuzzySearch(normalizedQuery, buildNonTaskAutocompleteItems(context), limit).map(({ item }) => mapAutocompleteCandidate(item));
  return [...projectMatches, ...taskMatches, ...otherMatches];
}

export function searchProjectTagAutocompleteCandidates(
  query: string,
  tasks: TaskSummary[],
  prioritizedTags: Iterable<string | null | undefined> = [],
  limit = 12,
): ComposerAutocompleteCandidate[] {
  const items = buildProjectTagAutocompleteItems(tasks, prioritizedTags);
  if (!query.trim()) {
    return items.slice(0, limit).map(({ id, insertText, label, detail }) => ({ id, insertText, label, detail }));
  }

  const prioritizedTagSet = new Set(normalizeTaskTags(prioritizedTags));
  return fuzzySearch(query, items, items.length || limit)
    .sort((left, right) => {
      const leftPriority = prioritizedTagSet.has(left.item.normalizedTag) ? 0 : 1;
      const rightPriority = prioritizedTagSet.has(right.item.normalizedTag) ? 0 : 1;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.item.label.localeCompare(right.item.label);
    })
    .slice(0, limit)
    .map(({ item }) => ({
      id: item.id,
      insertText: item.insertText,
      label: item.label,
      detail: item.detail,
    }));
}

export function buildProjectMentionLookup({ projects, tasks, agents, roles }: ProjectReferenceContext) {
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

  for (const project of projects) {
    const entry: ProjectMentionLink = {
      kind: "project",
      label: buildProjectMentionLabel(project),
      projectId: project.id,
    };
    lookup.set(normalizeToken(`@${project.slug}`), entry);

    const taskPrefixAlias = normalizeToken(`@${project.taskPrefix}`);
    if (!lookup.has(taskPrefixAlias)) {
      lookup.set(taskPrefixAlias, entry);
    }
  }

  return lookup;
}

export function mapTaskFileMentionAutocompleteCandidates(candidates: TaskCommentFileMentionCandidate[]): ComposerAutocompleteCandidate[] {
  return candidates.map((candidate) => ({
    id: `${candidate.repositoryId}:${candidate.relativePath}`,
    insertText: candidate.insertText,
    label: candidate.relativePath,
    detail: candidate.repositoryName,
  }));
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
