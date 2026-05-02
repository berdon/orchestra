import { invoke } from "@tauri-apps/api/core";

import { isHostedWebBrowserMode } from "./mockOrchestra/host";
import { getHostedWebOrchestraClientBinding } from "./orchestraClient/runtime";
import { getProject } from "./projects";
import type { NoteDetail, NoteLocation, NoteTreeNode, NotesRoot, NotesTree, ProjectDetail } from "../types";

const MOCK_NOTES_STORAGE_KEY = "orchestra.mock.notes";

type MockScopeNotes = {
  notes: Record<string, string>;
  directories: string[];
};

type MockNotesState = Record<string, MockScopeNotes>;

type DirectoryAccumulator = {
  name: string;
  path: string;
  directories: Map<string, DirectoryAccumulator>;
  notes: Map<string, NoteTreeNode>;
};

function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function getHostedWebClient() {
  return getHostedWebOrchestraClientBinding()?.client ?? null;
}

function loadMockNotesState(): MockNotesState {
  const raw = window.localStorage.getItem(MOCK_NOTES_STORAGE_KEY);
  return raw ? JSON.parse(raw) as MockNotesState : {};
}

function saveMockNotesState(state: MockNotesState) {
  window.localStorage.setItem(MOCK_NOTES_STORAGE_KEY, JSON.stringify(state));
}

function normalizePath(path: string, options?: { allowEmpty?: boolean; requireMarkdown?: boolean }) {
  const allowEmpty = options?.allowEmpty ?? false;
  const requireMarkdown = options?.requireMarkdown ?? false;
  const raw = path.trim().replace(/\\/g, "/");
  if (!raw && allowEmpty) {
    return "";
  }
  if (!raw) {
    throw new Error("path: Path is required.");
  }
  if (raw.startsWith("/") || raw.startsWith("~/")) {
    throw new Error("path: Note paths must stay relative to docs/.");
  }

  const parts = raw.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error("path: Note paths must stay inside docs/.");
    }
  }

  const normalized = parts.join("/");
  if (!normalized && !allowEmpty) {
    throw new Error("path: Path is required.");
  }
  if (requireMarkdown && normalized && !normalized.toLowerCase().endsWith(".md")) {
    throw new Error("path: Note files must end with .md.");
  }
  return normalized;
}

function normalizeLocation(location: NoteLocation, options?: { allowEmpty?: boolean; requireMarkdown?: boolean }) {
  const scope = location.scope === "repository" ? "repository" : "project";
  const repositoryId = scope === "repository" ? location.repositoryId?.trim() ?? "" : "";
  if (scope === "repository" && !repositoryId) {
    throw new Error("repositoryId: Repository note locations require repositoryId.");
  }
  return {
    scope,
    repositoryId: repositoryId || null,
    path: normalizePath(location.path, options),
  } satisfies NoteLocation;
}

function scopeStorageKey(projectId: string, location: NoteLocation) {
  return location.scope === "project"
    ? `${projectId}::project`
    : `${projectId}::repository:${location.repositoryId}`;
}

function ensureScopeState(state: MockNotesState, key: string): MockScopeNotes {
  if (!state[key]) {
    state[key] = { notes: {}, directories: [] };
  }
  return state[key]!;
}

function addParentDirectories(entry: MockScopeNotes, path: string) {
  const segments = path.split("/").filter(Boolean);
  const next = new Set(entry.directories);
  for (let index = 1; index < segments.length; index += 1) {
    next.add(segments.slice(0, index).join("/"));
  }
  entry.directories = Array.from(next).sort();
}

function deleteDirectoryContents(entry: MockScopeNotes, path: string) {
  const prefix = path ? `${path}/` : "";
  entry.directories = entry.directories.filter((directory) => directory !== path && !directory.startsWith(prefix));
  for (const notePath of Object.keys(entry.notes)) {
    if (notePath === path || notePath.startsWith(prefix)) {
      delete entry.notes[notePath];
    }
  }
}

function copyDirectoryContents(source: MockScopeNotes, sourcePath: string, destination: MockScopeNotes, destinationPath: string) {
  const sourcePrefix = sourcePath ? `${sourcePath}/` : "";
  const destinationPrefix = destinationPath ? `${destinationPath}/` : "";
  const nextDirectories = new Set(destination.directories);

  if (destinationPath) {
    nextDirectories.add(destinationPath);
    addParentDirectories(destination, destinationPath);
  }

  for (const directory of source.directories) {
    if (directory === sourcePath || directory.startsWith(sourcePrefix)) {
      const suffix = directory === sourcePath ? "" : directory.slice(sourcePrefix.length);
      const nextDirectory = [destinationPath, suffix].filter(Boolean).join("/");
      if (nextDirectory) {
        nextDirectories.add(nextDirectory);
      }
    }
  }

  for (const [notePath, markdown] of Object.entries(source.notes)) {
    if (notePath === sourcePath || notePath.startsWith(sourcePrefix)) {
      const suffix = notePath === sourcePath ? "" : notePath.slice(sourcePrefix.length);
      const nextPath = [destinationPath, suffix].filter(Boolean).join("/");
      destination.notes[nextPath] = markdown;
      addParentDirectories(destination, nextPath);
    }
  }

  destination.directories = Array.from(nextDirectories).sort();
}

function createDirectoryRoot(): DirectoryAccumulator {
  return {
    name: "",
    path: "",
    directories: new Map(),
    notes: new Map(),
  };
}

function ensureDirectory(root: DirectoryAccumulator, directoryPath: string) {
  let current = root;
  const segments = directoryPath.split("/").filter(Boolean);
  const built: string[] = [];
  for (const segment of segments) {
    built.push(segment);
    const currentPath = built.join("/");
    const existing = current.directories.get(segment);
    if (existing) {
      current = existing;
      continue;
    }
    const next: DirectoryAccumulator = {
      name: segment,
      path: currentPath,
      directories: new Map(),
      notes: new Map(),
    };
    current.directories.set(segment, next);
    current = next;
  }
  return current;
}

function buildTreeNodes(entry: MockScopeNotes): NoteTreeNode[] {
  const root = createDirectoryRoot();
  for (const directory of entry.directories) {
    if (directory) {
      ensureDirectory(root, directory);
    }
  }

  for (const notePath of Object.keys(entry.notes)) {
    const segments = notePath.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }
    const parent = segments.length ? ensureDirectory(root, segments.join("/")) : root;
    parent.notes.set(fileName, {
      kind: "note",
      name: fileName,
      path: notePath,
    });
  }

  const toNodes = (directory: DirectoryAccumulator): NoteTreeNode[] => {
    const directoryNodes = Array.from(directory.directories.values())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => ({
        kind: "directory" as const,
        name: child.name,
        path: child.path,
        children: toNodes(child),
      }));
    const noteNodes = Array.from(directory.notes.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    return [...directoryNodes, ...noteNodes];
  };

  return toNodes(root);
}

async function loadProjectDetail(projectId: string): Promise<ProjectDetail> {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} was not found.`);
  }
  return project;
}

function getRootState(projectId: string, location: NoteLocation, state: MockNotesState) {
  const key = scopeStorageKey(projectId, location);
  return ensureScopeState(state, key);
}

function assertLocationBelongsToProject(project: ProjectDetail, location: NoteLocation) {
  if (location.scope === "project") {
    return;
  }
  const repositoryId = location.repositoryId ?? "";
  if (!project.repositories.some((repository) => repository.id === repositoryId)) {
    throw new Error(`Repository ${repositoryId} does not belong to project ${project.id}.`);
  }
}

export async function listProjectNotes(projectId: string): Promise<NotesTree> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.list(projectId);
  }
  if (isTauriAvailable()) {
    return invoke<NotesTree>("list_project_notes", { projectId });
  }

  const project = await loadProjectDetail(projectId);
  const state = loadMockNotesState();
  const projectLocation: NoteLocation = { scope: "project", path: "" };
  const projectEntry = getRootState(projectId, projectLocation, state);
  const repositoryRoots = [...project.repositories]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((repository) => {
      const location: NoteLocation = { scope: "repository", repositoryId: repository.id, path: "" };
      const entry = getRootState(projectId, location, state);
      return {
        scope: "repository" as const,
        repositoryId: repository.id,
        label: repository.name,
        docsExists: Boolean(Object.keys(entry.notes).length || entry.directories.length),
        children: buildTreeNodes(entry),
      } satisfies NotesRoot;
    });

  return {
    projectId,
    roots: [
      {
        scope: "project",
        repositoryId: null,
        label: "Project",
        docsExists: Boolean(Object.keys(projectEntry.notes).length || projectEntry.directories.length),
        children: buildTreeNodes(projectEntry),
      },
      ...repositoryRoots,
    ],
  };
}

export async function getProjectNote(projectId: string, location: NoteLocation): Promise<NoteDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.get(projectId, location);
  }
  if (isTauriAvailable()) {
    return invoke<NoteDetail>("get_project_note", { projectId, location });
  }

  const project = await loadProjectDetail(projectId);
  const normalized = normalizeLocation(location, { requireMarkdown: true });
  assertLocationBelongsToProject(project, normalized);
  const state = loadMockNotesState();
  const entry = getRootState(projectId, normalized, state);
  const markdown = entry.notes[normalized.path];
  return {
    location: normalized,
    markdown: markdown ?? "",
    exists: markdown !== undefined,
  };
}

export async function updateProjectNote(projectId: string, location: NoteLocation, markdown: string): Promise<NoteDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.update(projectId, location, markdown);
  }
  if (isTauriAvailable()) {
    return invoke<NoteDetail>("update_project_note", { projectId, location, markdown });
  }

  const project = await loadProjectDetail(projectId);
  const normalized = normalizeLocation(location, { requireMarkdown: true });
  assertLocationBelongsToProject(project, normalized);
  const state = loadMockNotesState();
  const entry = getRootState(projectId, normalized, state);
  entry.notes[normalized.path] = markdown;
  addParentDirectories(entry, normalized.path);
  saveMockNotesState(state);
  return { location: normalized, markdown, exists: true };
}

export async function deleteProjectNote(projectId: string, location: NoteLocation): Promise<NoteLocation> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.delete(projectId, location);
  }
  if (isTauriAvailable()) {
    return invoke<NoteLocation>("delete_project_note", { projectId, location });
  }

  const project = await loadProjectDetail(projectId);
  const normalized = normalizeLocation(location, { requireMarkdown: true });
  assertLocationBelongsToProject(project, normalized);
  const state = loadMockNotesState();
  const entry = getRootState(projectId, normalized, state);
  delete entry.notes[normalized.path];
  saveMockNotesState(state);
  return normalized;
}

export async function copyProjectNote(projectId: string, source: NoteLocation, destination: NoteLocation): Promise<NoteDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.copy(projectId, source, destination);
  }
  if (isTauriAvailable()) {
    return invoke<NoteDetail>("copy_project_note", { projectId, source, destination });
  }

  const project = await loadProjectDetail(projectId);
  const normalizedSource = normalizeLocation(source, { requireMarkdown: true });
  const normalizedDestination = normalizeLocation(destination, { requireMarkdown: true });
  assertLocationBelongsToProject(project, normalizedSource);
  assertLocationBelongsToProject(project, normalizedDestination);
  const state = loadMockNotesState();
  const sourceEntry = getRootState(projectId, normalizedSource, state);
  const markdown = sourceEntry.notes[normalizedSource.path];
  if (markdown === undefined) {
    throw new Error(`Note ${normalizedSource.path} was not found.`);
  }
  const destinationEntry = getRootState(projectId, normalizedDestination, state);
  destinationEntry.notes[normalizedDestination.path] = markdown;
  addParentDirectories(destinationEntry, normalizedDestination.path);
  saveMockNotesState(state);
  return { location: normalizedDestination, markdown, exists: true };
}

export async function moveProjectNote(projectId: string, source: NoteLocation, destination: NoteLocation): Promise<NoteDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.move(projectId, source, destination);
  }
  if (isTauriAvailable()) {
    return invoke<NoteDetail>("move_project_note", { projectId, source, destination });
  }

  const copied = await copyProjectNote(projectId, source, destination);
  await deleteProjectNote(projectId, source);
  return copied;
}

export async function createProjectNotesDirectory(projectId: string, location: NoteLocation): Promise<NoteLocation> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.createDirectory(projectId, location);
  }
  if (isTauriAvailable()) {
    return invoke<NoteLocation>("create_project_notes_directory", { projectId, location });
  }

  const project = await loadProjectDetail(projectId);
  const normalized = normalizeLocation(location, { allowEmpty: true });
  assertLocationBelongsToProject(project, normalized);
  const state = loadMockNotesState();
  const entry = getRootState(projectId, normalized, state);
  const nextDirectories = new Set(entry.directories);
  if (normalized.path) {
    nextDirectories.add(normalized.path);
    addParentDirectories(entry, normalized.path);
  }
  entry.directories = Array.from(nextDirectories).sort();
  saveMockNotesState(state);
  return normalized;
}

export async function deleteProjectNotesDirectory(projectId: string, location: NoteLocation): Promise<NoteLocation> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.deleteDirectory(projectId, location);
  }
  if (isTauriAvailable()) {
    return invoke<NoteLocation>("delete_project_notes_directory", { projectId, location });
  }

  const project = await loadProjectDetail(projectId);
  const normalized = normalizeLocation(location, { allowEmpty: true });
  assertLocationBelongsToProject(project, normalized);
  const state = loadMockNotesState();
  const entry = getRootState(projectId, normalized, state);
  deleteDirectoryContents(entry, normalized.path);
  saveMockNotesState(state);
  return normalized;
}

export async function copyProjectNotesDirectory(projectId: string, source: NoteLocation, destination: NoteLocation): Promise<NoteLocation> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.copyDirectory(projectId, source, destination);
  }
  if (isTauriAvailable()) {
    return invoke<NoteLocation>("copy_project_notes_directory", { projectId, source, destination });
  }

  const project = await loadProjectDetail(projectId);
  const normalizedSource = normalizeLocation(source, { allowEmpty: true });
  const normalizedDestination = normalizeLocation(destination, { allowEmpty: true });
  assertLocationBelongsToProject(project, normalizedSource);
  assertLocationBelongsToProject(project, normalizedDestination);
  if (
    normalizedSource.scope === normalizedDestination.scope
    && normalizedSource.repositoryId === normalizedDestination.repositoryId
    && normalizedDestination.path
    && (normalizedDestination.path === normalizedSource.path || normalizedDestination.path.startsWith(`${normalizedSource.path}/`))
  ) {
    throw new Error("Destination directory cannot be the same directory or a descendant of the source directory.");
  }
  const state = loadMockNotesState();
  const sourceEntry = getRootState(projectId, normalizedSource, state);
  const destinationEntry = getRootState(projectId, normalizedDestination, state);
  copyDirectoryContents(sourceEntry, normalizedSource.path, destinationEntry, normalizedDestination.path);
  saveMockNotesState(state);
  return normalizedDestination;
}

export async function moveProjectNotesDirectory(projectId: string, source: NoteLocation, destination: NoteLocation): Promise<NoteLocation> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.notes.moveDirectory(projectId, source, destination);
  }
  if (isTauriAvailable()) {
    return invoke<NoteLocation>("move_project_notes_directory", { projectId, source, destination });
  }

  const moved = await copyProjectNotesDirectory(projectId, source, destination);
  await deleteProjectNotesDirectory(projectId, source);
  return moved;
}
