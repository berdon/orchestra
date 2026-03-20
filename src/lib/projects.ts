import { invoke } from "@tauri-apps/api/core";

import type { ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryUpsertInput } from "../types";

const PROJECT_STORAGE_KEY = "orchestra.mock.projects";
const ACTIVE_PROJECT_STORAGE_KEY = "orchestra.mock.active-project-id";
const DEFAULT_PROJECT_ID = "orchestra";
const DEFAULT_REPOSITORY_ID = "repo-orchestra";

function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
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

function seedMockProjects(): ProjectDetail[] {
  const timestamp = nowIso();
  return [
    {
      id: DEFAULT_PROJECT_ID,
      slug: "orchestra",
      name: "Orchestra",
      description: "Default Orchestra project",
      defaultRepositoryId: DEFAULT_REPOSITORY_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      repositories: [
        {
          id: DEFAULT_REPOSITORY_ID,
          projectId: DEFAULT_PROJECT_ID,
          slug: "orchestra",
          name: "Orchestra repository",
          localPath: "/home/openclaw/workspace/orchestra/repository",
          remoteUrl: null,
          defaultBranch: "main",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ];
}

function ensureMockProjects() {
  const existing = getStoredProjects();
  if (existing) {
    return existing;
  }

  const seeded = seedMockProjects();
  saveStoredProjects(seeded);
  if (!window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)) {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, seeded[0]!.id);
  }
  return seeded;
}

export function getActiveProjectId() {
  const projects = ensureMockProjects();
  const stored = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  return stored && projects.some((project) => project.id === stored) ? stored : projects[0]?.id ?? null;
}

export function setActiveProjectId(projectId: string) {
  window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
  window.dispatchEvent(new CustomEvent("orchestra:projects-changed"));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!isTauriAvailable()) {
    return ensureMockProjects().map(({ repositories, ...project }) => project);
  }

  return invoke<ProjectSummary[]>("list_projects");
}

export async function getProject(projectId: string): Promise<ProjectDetail> {
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

export async function createProject(input: ProjectUpsertInput): Promise<ProjectDetail> {
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const timestamp = nowIso();
    const project: ProjectDetail = {
      id: createId("project"),
      slug: slugify(input.name),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      defaultRepositoryId: null,
      repositories: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveStoredProjects([project, ...projects]);
    return project;
  }

  const project = await invoke<ProjectDetail>("create_project", { input });
  emitProjectsChanged();
  return project;
}

export async function updateProject(projectId: string, input: ProjectUpsertInput): Promise<ProjectDetail> {
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const existing = projects.find((project) => project.id === projectId);
    if (!existing) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const updated: ProjectDetail = {
      ...existing,
      slug: slugify(input.name),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      updatedAt: nowIso(),
    };
    saveStoredProjects(projects.map((project) => (project.id === projectId ? updated : project)));
    return updated;
  }

  const project = await invoke<ProjectDetail>("update_project", { projectId, input });
  emitProjectsChanged();
  return project;
}

export async function createRepository(projectId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord> {
  if (!isTauriAvailable()) {
    const projects = ensureMockProjects();
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const repository: RepositoryRecord = {
      id: createId("repo"),
      projectId,
      slug: slugify(input.name),
      name: input.name.trim(),
      localPath: input.localPath?.trim() || null,
      remoteUrl: input.remoteUrl?.trim() || null,
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
    return repository;
  }

  const repository = await invoke<RepositoryRecord>("create_repository", { projectId, input });
  emitProjectsChanged();
  return repository;
}

export async function updateRepository(repositoryId: string, input: RepositoryUpsertInput): Promise<RepositoryRecord> {
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
            slug: slugify(input.name),
            name: input.name.trim(),
            localPath: input.localPath?.trim() || null,
            remoteUrl: input.remoteUrl?.trim() || null,
            defaultBranch: input.defaultBranch?.trim() || null,
            updatedAt: nowIso(),
          };
          return updatedRepository;
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

export async function setProjectDefaultRepository(projectId: string, repositoryId: string | null): Promise<ProjectDetail> {
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
