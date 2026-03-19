import { basename, join } from "node:path";

export interface OrchestraSessionStorageInfo {
  orchestraRoot: string;
  projectRoot: string;
  sessionDir: string;
  projectSlug: string;
}

export function sanitizeSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "project";
}

export function getProjectSlugFromCwd(cwd: string) {
  return sanitizeSlug(basename(cwd));
}

export function getOrchestraRoot(homeDir: string) {
  return join(homeDir, ".orchestra");
}

export function getProjectRoot(homeDir: string, projectSlug: string) {
  return join(getOrchestraRoot(homeDir), "projects", sanitizeSlug(projectSlug));
}

export function getProjectSessionDir(homeDir: string, projectSlug: string) {
  return join(getProjectRoot(homeDir, projectSlug), "sessions");
}

export function buildSessionStorageInfo(homeDir: string, projectSlug: string): OrchestraSessionStorageInfo {
  return {
    orchestraRoot: getOrchestraRoot(homeDir),
    projectRoot: getProjectRoot(homeDir, projectSlug),
    sessionDir: getProjectSessionDir(homeDir, projectSlug),
    projectSlug: sanitizeSlug(projectSlug),
  };
}
