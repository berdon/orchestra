const PROJECT_SETTINGS_STORAGE_KEY = "orchestra.mock.project-settings";

export type MockProjectRuntimeSettings = {
  taskSessionContextTemplate?: string | null;
  autoDispatchOnBlockerCompletion?: boolean;
  gitUserNameTemplate?: string | null;
  gitEmailTemplate?: string | null;
  updatedAt?: string | null;
};

type MockWorkerOverlay = {
  prompt?: string | null;
  updatedAt?: string | null;
};

export type MockProjectSettingsStorage = {
  agentOverlays?: Record<string, MockWorkerOverlay>;
  roleOverlays?: Record<string, MockWorkerOverlay>;
  general?: MockProjectRuntimeSettings;
  projects?: Record<string, { runtime?: MockProjectRuntimeSettings }>;
};

export function getStoredMockProjectSettingsStorage(): MockProjectSettingsStorage {
  const value = window.localStorage.getItem(PROJECT_SETTINGS_STORAGE_KEY);
  return value ? (JSON.parse(value) as MockProjectSettingsStorage) : {};
}

export function saveStoredMockProjectSettingsStorage(settings: MockProjectSettingsStorage) {
  window.localStorage.setItem(PROJECT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function getStoredMockProjectRuntimeSettings(projectSlug: string): MockProjectRuntimeSettings {
  const settings = getStoredMockProjectSettingsStorage();
  return {
    ...(settings.general ?? {}),
    ...(settings.projects?.[projectSlug]?.runtime ?? {}),
  };
}

export function updateStoredMockProjectRuntimeSettings(
  projectSlug: string,
  updater: (current: MockProjectRuntimeSettings) => MockProjectRuntimeSettings,
): MockProjectRuntimeSettings {
  const settings = getStoredMockProjectSettingsStorage();
  const current = getStoredMockProjectRuntimeSettings(projectSlug);
  const nextRuntime = updater(current);
  settings.projects = {
    ...(settings.projects ?? {}),
    [projectSlug]: {
      ...(settings.projects?.[projectSlug] ?? {}),
      runtime: nextRuntime,
    },
  };
  saveStoredMockProjectSettingsStorage(settings);
  return nextRuntime;
}
