import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type { PiRuntimeSettings } from "../types";

const HARNESS_SETTINGS_STORAGE_KEY = "orchestra.mock.harness-settings";

function nowIso() {
  return new Date().toISOString();
}

function getStoredHarnessSettings(): PiRuntimeSettings {
  const value = window.localStorage.getItem(HARNESS_SETTINGS_STORAGE_KEY);
  return value
    ? (JSON.parse(value) as PiRuntimeSettings)
    : { extraExtensions: [], defaultCompactionWindow: "10%", updatedAt: null };
}

function saveStoredHarnessSettings(settings: PiRuntimeSettings) {
  window.localStorage.setItem(HARNESS_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function normalizeExtensions(extraExtensions: string[]) {
  const normalized: string[] = [];
  for (const entry of extraExtensions) {
    const trimmed = entry.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

export async function getPiRuntimeSettings(): Promise<PiRuntimeSettings> {
  if (!isTauriAvailable()) {
    return getStoredHarnessSettings();
  }

  return invoke<PiRuntimeSettings>("get_pi_runtime_settings");
}

export async function updatePiRuntimeSettings(input: {
  extraExtensions: string[];
  defaultCompactionWindow?: string | null;
}): Promise<PiRuntimeSettings> {
  if (!isTauriAvailable()) {
    const nextSettings: PiRuntimeSettings = {
      extraExtensions: normalizeExtensions(input.extraExtensions),
      defaultCompactionWindow: input.defaultCompactionWindow?.trim() || "10%",
      updatedAt: nowIso(),
    };
    saveStoredHarnessSettings(nextSettings);
    return nextSettings;
  }

  return invoke<PiRuntimeSettings>("update_pi_runtime_settings", {
    extraExtensions: input.extraExtensions,
    defaultCompactionWindow: input.defaultCompactionWindow ?? null,
  });
}
