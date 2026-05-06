import { join } from "node:path";

export function orchestraDevRoot(testHome: string) {
  return join(testHome, ".orchestra-dev");
}

export function orchestraProjectsRoot(testHome: string) {
  return join(orchestraDevRoot(testHome), "projects");
}

export function orchestraProjectRoot(testHome: string, projectSlug: string) {
  return join(orchestraProjectsRoot(testHome), projectSlug);
}

export function orchestraProjectSessionsRoot(testHome: string, projectSlug: string) {
  return join(orchestraProjectRoot(testHome, projectSlug), "sessions");
}
