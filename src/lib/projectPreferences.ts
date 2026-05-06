const ACTIVE_PROJECT_ID_STORAGE_KEY = "orchestra.preferences.active-project-id";
const LEGACY_ACTIVE_PROJECT_ID_STORAGE_KEY = "orchestra.mock.active-project-id";
const ACTIVE_PROJECT_SLUG_STORAGE_KEY = "orchestra.preferences.active-project-slug";
const PROJECTS_CHANGED_EVENT = "orchestra:projects-changed";

function readStorageValue(key: string) {
  return window.localStorage.getItem(key);
}

export function getStoredActiveProjectId() {
  return readStorageValue(ACTIVE_PROJECT_ID_STORAGE_KEY)
    ?? readStorageValue(LEGACY_ACTIVE_PROJECT_ID_STORAGE_KEY)
    ?? null;
}

export function getStoredActiveProjectSlug() {
  return readStorageValue(ACTIVE_PROJECT_SLUG_STORAGE_KEY) ?? null;
}

export function setStoredActiveProject(projectId: string | null, projectSlug?: string | null) {
  const previousProjectId = getStoredActiveProjectId();
  const previousProjectSlug = getStoredActiveProjectSlug();

  if (projectId) {
    window.localStorage.setItem(ACTIVE_PROJECT_ID_STORAGE_KEY, projectId);
    window.localStorage.setItem(LEGACY_ACTIVE_PROJECT_ID_STORAGE_KEY, projectId);
  } else {
    window.localStorage.removeItem(ACTIVE_PROJECT_ID_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_ACTIVE_PROJECT_ID_STORAGE_KEY);
  }

  const normalizedSlug = projectSlug?.trim() || null;
  if (normalizedSlug) {
    window.localStorage.setItem(ACTIVE_PROJECT_SLUG_STORAGE_KEY, normalizedSlug);
  } else {
    window.localStorage.removeItem(ACTIVE_PROJECT_SLUG_STORAGE_KEY);
  }

  if (previousProjectId !== projectId || previousProjectSlug !== normalizedSlug) {
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  }
}

export function syncStoredActiveProjectSlug(projectId: string | null, projectSlug: string | null | undefined) {
  if (!projectId) {
    window.localStorage.removeItem(ACTIVE_PROJECT_SLUG_STORAGE_KEY);
    return;
  }

  const activeProjectId = getStoredActiveProjectId();
  if (activeProjectId !== projectId) {
    return;
  }

  const normalizedSlug = projectSlug?.trim() || null;
  if (normalizedSlug) {
    window.localStorage.setItem(ACTIVE_PROJECT_SLUG_STORAGE_KEY, normalizedSlug);
  } else {
    window.localStorage.removeItem(ACTIVE_PROJECT_SLUG_STORAGE_KEY);
  }
}
