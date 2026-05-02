import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type {
  HarnessModelLimitPolicy,
  HarnessModelLimitsSnapshot,
  HarnessModelRef,
  HarnessUsageSource,
  PiRuntimeSettings,
} from "../types";

const HARNESS_SETTINGS_STORAGE_KEY = "orchestra.mock.harness-settings";

type StoredHarnessSettings = {
  runtime?: PiRuntimeSettings;
  modelLimits?: HarnessModelLimitsSnapshot;
};

function nowIso() {
  return new Date().toISOString();
}

function defaultRuntimeSettings(): PiRuntimeSettings {
  return { extraExtensions: [], defaultCompactionWindow: "10%", updatedAt: null };
}

function getStoredHarnessSettings(): StoredHarnessSettings {
  const value = window.localStorage.getItem(HARNESS_SETTINGS_STORAGE_KEY);
  return value ? (JSON.parse(value) as StoredHarnessSettings) : {};
}

function saveStoredHarnessSettings(settings: StoredHarnessSettings) {
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

function resolveStoredRuntimeSettings() {
  const stored = getStoredHarnessSettings();
  if (stored.runtime) {
    return stored.runtime;
  }
  if (Array.isArray((stored as PiRuntimeSettings).extraExtensions)) {
    return stored as PiRuntimeSettings;
  }
  return defaultRuntimeSettings();
}

function usageSourceForModel(modelRef: HarnessModelRef): HarnessUsageSource {
  if (modelRef.provider.trim().toLowerCase() === "zai") {
    return { adapter: "zai_quota", scopeKey: "shared_supported_models" };
  }
  return { adapter: "unsupported", scopeKey: `${modelRef.provider}:${modelRef.modelId}` };
}

function sameModelRef(left: HarnessModelRef, right: HarnessModelRef) {
  return left.provider === right.provider && left.modelId === right.modelId && (left.api ?? null) === (right.api ?? null);
}

function buildRules(rolling5hPercent?: number | null, weeklyPercent?: number | null) {
  const rules = [] as HarnessModelLimitPolicy["rules"];
  if (typeof rolling5hPercent === "number") {
    rules.push({ metricKey: "rolling_5h_percent", thresholdKind: "percent", thresholdValue: rolling5hPercent, action: "pause" });
  }
  if (typeof weeklyPercent === "number") {
    rules.push({ metricKey: "weekly_percent", thresholdKind: "percent", thresholdValue: weeklyPercent, action: "pause" });
  }
  return rules;
}

function resolveStoredModelLimits(): HarnessModelLimitsSnapshot {
  return getStoredHarnessSettings().modelLimits ?? { policies: [], states: [] };
}

export async function getPiRuntimeSettings(): Promise<PiRuntimeSettings> {
  if (!isTauriAvailable()) {
    return resolveStoredRuntimeSettings();
  }

  return invoke<PiRuntimeSettings>("get_pi_runtime_settings");
}

export async function updatePiRuntimeSettings(input: {
  extraExtensions: string[];
  defaultCompactionWindow?: string | null;
}): Promise<PiRuntimeSettings> {
  if (!isTauriAvailable()) {
    const current = getStoredHarnessSettings();
    const nextSettings: PiRuntimeSettings = {
      extraExtensions: normalizeExtensions(input.extraExtensions),
      defaultCompactionWindow: input.defaultCompactionWindow?.trim() || "10%",
      updatedAt: nowIso(),
    };
    saveStoredHarnessSettings({ ...current, runtime: nextSettings });
    return nextSettings;
  }

  return invoke<PiRuntimeSettings>("update_pi_runtime_settings", {
    extraExtensions: input.extraExtensions,
    defaultCompactionWindow: input.defaultCompactionWindow ?? null,
  });
}

export async function getHarnessModelLimitsSnapshot(): Promise<HarnessModelLimitsSnapshot> {
  if (!isTauriAvailable()) {
    return resolveStoredModelLimits();
  }

  return invoke<HarnessModelLimitsSnapshot>("get_harness_model_limits_snapshot");
}

export async function saveHarnessModelLimitPolicy(input: {
  modelRef: HarnessModelRef;
  rolling5hPercent?: number | null;
  weeklyPercent?: number | null;
}): Promise<HarnessModelLimitsSnapshot> {
  if (!isTauriAvailable()) {
    const current = getStoredHarnessSettings();
    const snapshot = resolveStoredModelLimits();
    const policies = snapshot.policies.filter((policy) => !sameModelRef(policy.modelRef, input.modelRef));
    const rules = buildRules(input.rolling5hPercent ?? null, input.weeklyPercent ?? null);
    if (rules.length) {
      policies.push({
        modelRef: input.modelRef,
        usageSource: usageSourceForModel(input.modelRef),
        rules,
        updatedAt: nowIso(),
      });
    }
    const nextSnapshot: HarnessModelLimitsSnapshot = { policies, states: snapshot.states.filter((state) => !sameModelRef(state.modelRef, input.modelRef)) };
    saveStoredHarnessSettings({ ...current, modelLimits: nextSnapshot });
    return nextSnapshot;
  }

  return invoke<HarnessModelLimitsSnapshot>("save_harness_model_limit_policy", {
    modelRef: input.modelRef,
    rolling5hPercent: input.rolling5hPercent ?? null,
    weeklyPercent: input.weeklyPercent ?? null,
  });
}
