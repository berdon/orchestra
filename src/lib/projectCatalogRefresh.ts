import type { ProjectSummary } from "../types";

export function createProjectCatalogRefresher(
  listProjects: () => Promise<ProjectSummary[]>,
  applyProjects: (projects: ProjectSummary[]) => void,
) {
  let latestRequestId = 0;

  return async function refreshProjectCatalog() {
    const requestId = ++latestRequestId;
    const projects = await listProjects();
    if (requestId !== latestRequestId) {
      return false;
    }
    applyProjects(projects);
    return true;
  };
}

export function resolveActiveProjectIdAfterProjectCatalogRefresh(
  projects: ProjectSummary[],
  storedActiveProjectId: string | null,
  currentActiveProjectId: string | null,
) {
  if (
    storedActiveProjectId &&
    projects.some((project) => project.id === storedActiveProjectId)
  ) {
    return storedActiveProjectId;
  }
  if (
    currentActiveProjectId &&
    projects.some((project) => project.id === currentActiveProjectId)
  ) {
    return currentActiveProjectId;
  }
  return projects[0]?.id ?? null;
}
