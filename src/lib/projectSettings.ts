import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type { ProjectWorkerOverlay } from "../types";

const PROJECT_SETTINGS_STORAGE_KEY = "orchestra.mock.project-settings";
const DEFAULT_PROJECT_SLUG = "orchestra";

type MockProjectSettings = {
  agentOverlays?: Record<string, { prompt?: string | null; updatedAt?: string | null }>;
  roleOverlays?: Record<string, { prompt?: string | null; updatedAt?: string | null }>;
};

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function getStoredProjectSettings(): MockProjectSettings {
  const value = window.localStorage.getItem(PROJECT_SETTINGS_STORAGE_KEY);
  return value ? (JSON.parse(value) as MockProjectSettings) : {};
}

function saveStoredProjectSettings(settings: MockProjectSettings) {
  window.localStorage.setItem(PROJECT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function overlayKey(workerSlug: string) {
  return slugify(workerSlug, "worker");
}

export async function getWorkerOverlay(workerType: string, workerSlug: string, projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectWorkerOverlay> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    const normalizedWorkerType = workerType === "role" ? "role" : "agent";
    const normalizedWorkerSlug = overlayKey(workerSlug);
    const overlay = normalizedWorkerType === "role"
      ? settings.roleOverlays?.[normalizedWorkerSlug]
      : settings.agentOverlays?.[normalizedWorkerSlug];

    return {
      projectSlug,
      workerType: normalizedWorkerType,
      workerSlug: normalizedWorkerSlug,
      prompt: overlay?.prompt ?? null,
      updatedAt: overlay?.updatedAt ?? null,
    };
  }

  return invoke<ProjectWorkerOverlay>("get_worker_overlay", { projectSlug, workerType, workerSlug });
}

export async function updateWorkerOverlay(workerType: string, workerSlug: string, prompt: string, projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectWorkerOverlay> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    const normalizedWorkerType = workerType === "role" ? "role" : "agent";
    const normalizedWorkerSlug = overlayKey(workerSlug);
    const nextOverlay = {
      prompt: prompt.trim() || null,
      updatedAt: nowIso(),
    };

    if (normalizedWorkerType === "role") {
      settings.roleOverlays = {
        ...(settings.roleOverlays ?? {}),
        [normalizedWorkerSlug]: nextOverlay,
      };
    } else {
      settings.agentOverlays = {
        ...(settings.agentOverlays ?? {}),
        [normalizedWorkerSlug]: nextOverlay,
      };
    }

    saveStoredProjectSettings(settings);

    return {
      projectSlug,
      workerType: normalizedWorkerType,
      workerSlug: normalizedWorkerSlug,
      prompt: nextOverlay.prompt,
      updatedAt: nextOverlay.updatedAt,
    };
  }

  return invoke<ProjectWorkerOverlay>("update_worker_overlay", { projectSlug, workerType, workerSlug, prompt });
}
