import { invoke } from "@tauri-apps/api/core";

import { buildSeededMockProjects, DEFAULT_INSTALL_BASELINE_PROJECT_ID } from "./defaultInstallBaseline";
import { isHostedWebBrowserMode } from "./mockOrchestra/host";
import { getStoredActiveProjectId, getStoredActiveProjectSlug, setStoredActiveProject } from "./projectPreferences";
import { normalizeTaskPrefix, suggestTaskPrefix, validateTaskPrefix } from "./taskPrefixes";
import { getHostedWebOrchestraClientBinding } from "./orchestraClient/runtime";
import type {
  ProjectDetail,
  ProjectSummary,
  ProjectUpsertInput,
  RepositoryRecord,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
} from "../types";

const PROJECT_STORAGE_KEY = "orchestra.mock.projects";
const SESSION_STORAGE_KEY = "orchestra.mock.sessions";
const SESSION_MODEL_STORAGE_KEY = "orchestra.mock.session-models";
const DISMISSED_SESSION_STORAGE_KEY = "orchestra.mock.dismissed-sessions";
const TASK_STORAGE_KEY = "orchestra.mock.tasks";
const TASK_DEPENDENCY_STORAGE_KEY = "orchestra.mock.task-dependencies";
const TASK_COMMENT_USER_RECEIPT_STORAGE_KEY = "orchestra.mock.task-comment-user-receipts";
const MAILBOX_STORAGE_KEY = "orchestra.mock.mailbox";
const AGENT_RUNTIME_STORAGE_KEY = "orchestra.mock.agent-runtimes";
const AGENT_QUEUE_STORAGE_KEY = "orchestra.mock.agent-queue";
const TASK_SCHEDULE_STORAGE_KEY = "orchestra.mock.task-schedules";
const DOMAIN_EVENT_STORAGE_KEY = "orchestra.mock.domain-events";
const NO_PROJECT_RUNTIME_KEY = "no-project";

function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function getHostedWebClient() {
  return getHostedWebOrchestraClientBinding()?.client ?? null;
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function getStoredProjects() {
  const value = window.localStorage.getItem(PROJECT_STORAGE_KEY);
  return value ? (JSON.parse(value) as ProjectDetail[]) : null;
}

function saveStoredProjects(projects: ProjectDetail[]) {
  window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projects));
  window.dispatchEvent(new CustomEvent("orchestra:projects-changed"));
}

function getStoredArray<T>(key: string): T[] {
  const value = window.localStorage.getItem(key);
  return value ? (JSON.parse(value) as T[]) : [];
}

function saveStoredArray<T>(key: string, value: T[]) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function deleteProjectScopedMockState(projectId: string) {
  const deletedTaskIds = new Set(
    getStoredArray<{ id: string; projectId?: string | null }>(TASK_STORAGE_KEY)
      .filter((task) => task.projectId === projectId)
      .map((task) => task.id),
  );
  const deletedScheduleIds = new Set(
    getStoredArray<{ id: string; projectId?: string | null }>(TASK_SCHEDULE_STORAGE_KEY)
      .filter((schedule) => schedule.projectId === projectId)
      .map((schedule) => schedule.id),
  );

  saveStoredArray(
    TASK_STORAGE_KEY,
    getStoredArray<{ id: string; projectId?: string | null }>(TASK_STORAGE_KEY).filter((task) => task.projectId !== projectId),
  );
  saveStoredArray(
    TASK_DEPENDENCY_STORAGE_KEY,
    getStoredArray<{ blockerTaskId: string; blockedTaskId: string }>(TASK_DEPENDENCY_STORAGE_KEY)
      .filter((dependency) => !deletedTaskIds.has(dependency.blockerTaskId) && !deletedTaskIds.has(dependency.blockedTaskId)),
  );
  saveStoredArray(
    TASK_COMMENT_USER_RECEIPT_STORAGE_KEY,
    getStoredArray<{ taskId: string }>(TASK_COMMENT_USER_RECEIPT_STORAGE_KEY)
      .filter((receipt) => !deletedTaskIds.has(receipt.taskId)),
  );
  saveStoredArray(
    MAILBOX_STORAGE_KEY,
    getStoredArray<{ projectId?: string | null; taskId?: string | null }>(MAILBOX_STORAGE_KEY)
      .filter((message) => message.projectId !== projectId && !(message.taskId && deletedTaskIds.has(message.taskId))),
  );
  saveStoredArray(
    AGENT_RUNTIME_STORAGE_KEY,
    getStoredArray<{ projectId?: string | null }>(AGENT_RUNTIME_STORAGE_KEY)
      .filter((runtime) => runtime.projectId !== projectId),
  );
  saveStoredArray(
    AGENT_QUEUE_STORAGE_KEY,
    getStoredArray<{ projectId?: string | null; sourceTaskId?: string | null }>(AGENT_QUEUE_STORAGE_KEY)
      .filter((entry) => entry.projectId !== projectId && !(entry.sourceTaskId && deletedTaskIds.has(entry.sourceTaskId))),
  );
  saveStoredArray(
    TASK_SCHEDULE_STORAGE_KEY,
    getStoredArray<{ id: string; projectId?: string | null }>(TASK_SCHEDULE_STORAGE_KEY)
      .filter((schedule) => schedule.projectId !== projectId),
  );
  saveStoredArray(
    DOMAIN_EVENT_STORAGE_KEY,
    getStoredArray<{ projectId?: string | null; entityId?: string | null }>(DOMAIN_EVENT_STORAGE_KEY)
      .filter((event) => event.projectId !== projectId)
      .filter((event) => !event.entityId || (!deletedTaskIds.has(event.entityId) && !deletedScheduleIds.has(event.entityId))),
  );

  window.localStorage.removeItem(`${SESSION_STORAGE_KEY}.${projectId}`);
  window.localStorage.removeItem(`${SESSION_MODEL_STORAGE_KEY}.${projectId}`);
  window.localStorage.removeItem(`${DISMISSED_SESSION_STORAGE_KEY}.${projectId}`);
}

function seedMockProjects(): ProjectDetail[] {
  return buildSeededMockProjects(nowIso());
}

function validateMockProjectInput(input: ProjectUpsertInput, existingProjects: ProjectDetail[], projectId?: string) {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Project name is required.");
  }

  const taskPrefixError = validateTaskPrefix(input.taskPrefix);
  if (taskPrefixError) {
    throw new Error(taskPrefixError);
  }

  const normalizedTaskPrefix = normalizeTaskPrefix(input.taskPrefix);
  const duplicate = existingProjects.some((project) => project.id !== projectId && normalizeTaskPrefix(project.taskPrefix) === normalizedTaskPrefix);
  if (duplicate) {
    throw new Error(`Task prefix ${normalizedTaskPrefix} is already used by another project.`);
  }

  return { name, taskPrefix: normalizedTaskPrefix };
}

function migrateStoredProjects(projects: ProjectDetail[]) {
  const usedPrefixes = new Set<string>();
  let changed = false;
  const migratedProjects = projects.map((project) => {
    const normalizedTaskPrefix = normalizeTaskPrefix(project.taskPrefix);
    const nextTaskPrefix = !validateTaskPrefix(normalizedTaskPrefix) && !usedPrefixes.has(normalizedTaskPrefix)
      ? normalizedTaskPrefix
      : suggestTaskPrefix(project.id === DEFAULT_INSTALL_BASELINE_PROJECT_ID ? "Orchestra" : project.name, usedPrefixes);
    usedPrefixes.add(nextTaskPrefix);
    if (project.taskPrefix === nextTaskPrefix) {
      return project;
    }
    changed = true;
    return { ...project, taskPrefix: nextTaskPrefix };
  });

  if (changed) {
    saveStoredProjects(migratedProjects);
  }

  return migratedProjects;
}

function ensureMockProjects() {
  const existing = getStoredProjects();
  if (existing) {
    return migrateStoredProjects(existing);
  }

  const seeded = seedMockProjects();
  saveStoredProjects(seeded);
  if (!getStoredActiveProjectId() && seeded[0]) {
    setStoredActiveProject(seeded[0].id, seeded[0].slug);
  }
  return seeded;
}

function resolveStoredProjectId(projects: ProjectDetail[], preferredId?: string | null) {
  if (preferredId && projects.some((project) => project.id === preferredId)) {
    return preferredId;
  }
  return projects[0]?.id ?? null;
}

export function getDefaultProjectId() {
  const stored = getStoredActiveProjectId();
  if (isTauriAvailable() || isHostedWebBrowserMode()) {
    return stored;
  }
  const projects = ensureMockProjects();
  return resolveStoredProjectId(projects, stored);
}

export function getActiveProjectId() {
  const stored = getStoredActiveProjectId();
  if (isTauriAvailable() || isHostedWebBrowserMode()) {
    return stored;
  }

  const projects = ensureMockProjects();
  return resolveStoredProjectId(projects, stored);
}

export function getActiveProjectSlug() {
  if (isHostedWebBrowserMode()) {
    return getStoredActiveProjectSlug();
  }
  if (isTauriAvailable()) {
    return getStoredActiveProjectSlug();
  }

  const projects = ensureMockProjects();
  const activeProjectId = resolveStoredProjectId(projects, getStoredActiveProjectId());
  return projects.find((project) => project.id === activeProjectId)?.slug ?? projects[0]?.slug ?? null;
}

export function getProjectRuntimeCwd(projectId?: string | null) {
  if (isTauriAvailable() || isHostedWebBrowserMode()) {
    const resolvedProjectId = projectId ?? getActiveProjectId();
    return `/mock/projects/${resolvedProjectId ?? DEFAULT_INSTALL_BASELINE_PROJECT_ID}`;
  }

  const projects = ensureMockProjects();
  const resolvedProjectId = resolveStoredProjectId(projects, projectId ?? getActiveProjectId());
  const project = resolvedProjectId ? projects.find((entry) => entry.id === resolvedProjectId) ?? null : null;
  const defaultRepository = project?.defaultRepositoryId
    ? project.repositories.find((repository) => repository.id === project.defaultRepositoryId) ?? null
    : project?.repositories[0] ?? null;

  return defaultRepository?.repositoryPath ?? `/mock/projects/${project?.slug ?? resolvedProjectId ?? NO_PROJECT_RUNTIME_KEY}`;
}

export function setActiveProjectId(projectId: string | null, projectSlug?: string | null) {
  setStoredActiveProject(projectId, projectSlug);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.catalog.listProjects();
  }
  if (!isTauriAvailable()) {
    return ensureMockProjects().map(({ repositories, ...project }) => project);
  }

  return invoke<ProjectSummary[]>("list_projects");
}

export async function getProject(projectId: string): Promise<ProjectDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.catalog.getProject(projectId);
  }
  if (!isTauriAvailable()) {
    const project = ensureMockProjects().find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} was not found`);
    }
    return project;
  }

  return invoke<ProjectDetail>("get_project", { projectId });
}

function emitProjectsChanged() {
  window.dispatchEvent(new CustomEvent("orchestra:projects-changed"));
}

export async function listRepositories(projectId?: string | null): Promise<RepositoryRecord[]> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.listRepositories(projectId ?? null);
  }
  if (!isTauriAvailable()) {
    if (projectId) {
      return getProject(projectId).then((project) => project.repositories);
    }
    return ensureMockProjects().flatMap((project) => project.repositories);
  }

  return invoke<RepositoryRecord[]>("list_repositories", { projectId: projectId ?? null });
}

export async function getRepository(repositoryId: string): Promise<RepositoryRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.getRepository(repositoryId);
  }
  if (!isTauriAvailable()) {
    const repository = ensureMockProjects().flatMap((project) => project.repositories).find((entry) => entry.id === repositoryId) ?? null;
    if (!repository) {
      throw new Error(`Repository ${repositoryId} was not found`);
    }
    return repository;
  }

  return invoke<RepositoryRecord>("get_repository", { repositoryId });
}

export async function createProject(input: ProjectUpsertInput): Promise<ProjectDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.createProject(input);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const { name, taskPrefix } = validateMockProjectInput(input, projects);
    const timestamp = nowIso();
    const project: ProjectDetail = {
      id: createId("project"),
      slug: slugify(name),
      name,
      description: input.description?.trim() || null,
      taskPrefix,
      defaultRepositoryId: null,
      repositories: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveStoredProjects([project, ...projects]);
    setActiveProjectId(project.id, project.slug);
    return project;
  }

  const project = await invoke<ProjectDetail>("create_project", { input });
  emitProjectsChanged();
  return project;
}

export async function updateProject(projectId: string, input: ProjectUpsertInput): Promise<ProjectDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.updateProject(projectId, input);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const existing = projects.find((project) => project.id === projectId);
    if (!existing) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const { name, taskPrefix } = validateMockProjectInput(input, projects, projectId);
    const updated: ProjectDetail = {
      ...existing,
      slug: slugify(name),
      name,
      description: input.description?.trim() || null,
      taskPrefix,
      updatedAt: nowIso(),
    };
    saveStoredProjects(projects.map((project) => (project.id === projectId ? updated : project)));
    return updated;
  }

  const project = await invoke<ProjectDetail>("update_project", { projectId, input });
  emitProjectsChanged();
  return project;
}

export async function deleteProject(projectId: string): Promise<ProjectDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.deleteProject(projectId);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const existing = projects.find((project) => project.id === projectId);
    if (!existing) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const activeProjectId = getStoredActiveProjectId();
    const nextProjects = projects.filter((project) => project.id !== projectId);
    if (activeProjectId === projectId) {
      const fallbackProject = nextProjects[0] ?? null;
      setActiveProjectId(fallbackProject?.id ?? null, fallbackProject?.slug ?? null);
    }
    deleteProjectScopedMockState(projectId);
    saveStoredProjects(nextProjects);
    emitProjectsChanged();
    return existing;
  }

  const project = await invoke<ProjectDetail>("delete_project", { projectId });
  emitProjectsChanged();
  return project;
}

export async function createRepository(projectId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.createRepository(projectId, input);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const mode = input.mode === "local_new" ? "local_new" : "existing";
    const repository: RepositoryRecord = {
      id: createId("repo"),
      projectId,
      slug: slugify(input.name),
      name: input.name.trim(),
      repositoryPath: mode === "local_new"
        ? `/mock/projects/${project.slug}/repositories/${slugify(input.name)}/repository`
        : input.repositoryPath?.trim() || null,
      sourcePath: mode === "existing" ? input.repositoryPath?.trim() || null : null,
      sourceKind: mode === "existing"
        ? (input.repositoryPath?.trim() ? (input.repositoryPath!.includes("://") || input.repositoryPath!.includes("@") ? "remote" : "local") : null)
        : null,
      mode,
      defaultBranch: input.defaultBranch?.trim() || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const updatedProject: ProjectDetail = {
      ...project,
      repositories: [repository, ...project.repositories],
      defaultRepositoryId: project.defaultRepositoryId ?? repository.id,
      updatedAt: nowIso(),
    };
    saveStoredProjects(projects.map((entry) => (entry.id === projectId ? updatedProject : entry)));
    if (getActiveProjectId() === projectId) {
      window.dispatchEvent(new CustomEvent("orchestra:projects-changed"));
    }
    return repository;
  }

  const repository = await invoke<RepositoryRecord>("create_repository", { projectId, input });
  emitProjectsChanged();
  return repository;
}

export async function updateRepository(repositoryId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.updateRepository(repositoryId, input);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    let updatedRepository: RepositoryRecord | null = null;
    saveStoredProjects(
      projects.map((project) => ({
        ...project,
        repositories: project.repositories.map((repository) => {
          if (repository.id !== repositoryId) {
            return repository;
          }
          const mode = repository.mode ?? (input.mode === "local_new" ? "local_new" : "existing");
          const nextSourcePath = mode === "local_new" ? repository.sourcePath ?? null : input.repositoryPath?.trim() || null;
          updatedRepository = {
            ...repository,
            slug: slugify(input.name),
            name: input.name.trim(),
            repositoryPath: mode === "local_new" ? repository.repositoryPath ?? null : input.repositoryPath?.trim() || null,
            sourcePath: nextSourcePath,
            sourceKind: mode === "local_new" ? repository.sourceKind ?? null : (nextSourcePath ? (nextSourcePath.includes("://") || nextSourcePath.includes("@") ? "remote" : "local") : null),
            mode,
            defaultBranch: input.defaultBranch?.trim() || null,
            updatedAt: nowIso(),
          };
          return updatedRepository as RepositoryRecord;
        }),
      })),
    );
    if (!updatedRepository) {
      throw new Error(`Repository ${repositoryId} was not found`);
    }
    return updatedRepository;
  }

  const repository = await invoke<RepositoryRecord>("update_repository", { repositoryId, input });
  emitProjectsChanged();
  return repository;
}

export async function deleteRepository(repositoryId: string): Promise<RepositoryRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.deleteRepository(repositoryId);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    let deletedRepository: RepositoryRecord | null = null;
    saveStoredProjects(
      projects.map((project) => {
        const repository = project.repositories.find((entry) => entry.id === repositoryId) ?? null;
        if (!repository) {
          return project;
        }
        deletedRepository = repository;
        const nextRepositories = project.repositories.filter((entry) => entry.id !== repositoryId);
        return {
          ...project,
          repositories: nextRepositories,
          defaultRepositoryId: project.defaultRepositoryId === repositoryId ? nextRepositories[0]?.id ?? null : project.defaultRepositoryId,
          updatedAt: nowIso(),
        };
      }),
    );
    if (!deletedRepository) {
      throw new Error(`Repository ${repositoryId} was not found`);
    }
    return deletedRepository;
  }

  const repository = await invoke<RepositoryRecord>("delete_repository", { repositoryId });
  emitProjectsChanged();
  return repository;
}

export async function attachRepositoryRemote(repositoryId: string, input: RepositoryRemoteInput): Promise<RepositoryRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.attachRepositoryRemote(repositoryId, input);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    let updatedRepository: RepositoryRecord | null = null;
    saveStoredProjects(
      projects.map((project) => ({
        ...project,
        repositories: project.repositories.map((repository) => {
          if (repository.id !== repositoryId) {
            return repository;
          }
          updatedRepository = {
            ...repository,
            sourcePath: input.remoteUrl.trim(),
            sourceKind: "remote",
            updatedAt: nowIso(),
          };
          return updatedRepository as RepositoryRecord;
        }),
      })),
    );
    if (!updatedRepository) {
      throw new Error(`Repository ${repositoryId} was not found`);
    }
    return updatedRepository;
  }

  const repository = await invoke<RepositoryRecord>("attach_repository_remote", { repositoryId, input });
  emitProjectsChanged();
  return repository;
}

export async function setProjectDefaultRepository(projectId: string, repositoryId: string | null): Promise<ProjectDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.projects.setProjectDefaultRepository(projectId, repositoryId);
  }
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    let updatedProject: ProjectDetail | null = null;
    saveStoredProjects(
      projects.map((project) => {
        if (project.id !== projectId) {
          return project;
        }
        updatedProject = {
          ...project,
          defaultRepositoryId: repositoryId,
          updatedAt: nowIso(),
        };
        return updatedProject;
      }),
    );
    if (!updatedProject) {
      throw new Error(`Project ${projectId} was not found`);
    }
    return updatedProject;
  }

  const project = await invoke<ProjectDetail>("set_project_default_repository", { projectId, repositoryId });
  emitProjectsChanged();
  return project;
}
