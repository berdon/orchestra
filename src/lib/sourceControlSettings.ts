import { invoke } from "@tauri-apps/api/core";

import { getActiveProjectSlug } from "./projects";
import { isTauriAvailable } from "./tauri";
import {
  getStoredMockProjectRuntimeSettings,
  updateStoredMockProjectRuntimeSettings,
} from "./mockProjectRuntimeSettings";
import type {
  ProjectSourceControlSettings,
  SourceControlSettings,
} from "../types";

const SOURCE_CONTROL_STORAGE_KEY = "orchestra.mock.source-control-settings";
const DEFAULT_PROJECT_SLUG = "orchestra";

export type SourceControlFieldOrigin = "project_override" | "global_default" | "unset";

export interface SourceControlTemplateSettings {
  gitUserNameTemplate?: string | null;
  gitEmailTemplate?: string | null;
}

export interface SourceControlPreviewField {
  template: string | null;
  resolved: string | null;
  origin: SourceControlFieldOrigin;
}

export interface SourceControlPreviewRow {
  key: "role" | "agent" | "no_worker";
  label: string;
  gitUserName: SourceControlPreviewField;
  gitEmail: SourceControlPreviewField;
  warnings: string[];
}

const PREVIEW_CONTEXTS = [
  { key: "role" as const, label: "Role preview", role: "architect", agent: "" },
  { key: "agent" as const, label: "Agent preview", role: "", agent: "reviewer" },
  { key: "no_worker" as const, label: "No-worker preview", role: "", agent: "" },
];

function nowIso() {
  return new Date().toISOString();
}

function resolveProjectSlug(projectSlug?: string | null) {
  return projectSlug ?? getActiveProjectSlug() ?? DEFAULT_PROJECT_SLUG;
}

function normalizeTemplate(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function getStoredSourceControlSettings(): SourceControlSettings {
  const value = window.localStorage.getItem(SOURCE_CONTROL_STORAGE_KEY);
  return value ? (JSON.parse(value) as SourceControlSettings) : {};
}

function saveStoredSourceControlSettings(settings: SourceControlSettings) {
  window.localStorage.setItem(SOURCE_CONTROL_STORAGE_KEY, JSON.stringify(settings));
}

export function getSourceControlOriginLabel(origin: SourceControlFieldOrigin) {
  switch (origin) {
    case "project_override":
      return "Project override";
    case "global_default":
      return "Global default";
    default:
      return "Unset";
  }
}

export function resolveSourceControlFieldOrigin(
  projectTemplate?: string | null,
  globalTemplate?: string | null,
): { template: string | null; origin: SourceControlFieldOrigin } {
  const normalizedProjectTemplate = normalizeTemplate(projectTemplate);
  if (normalizedProjectTemplate) {
    return { template: normalizedProjectTemplate, origin: "project_override" };
  }
  const normalizedGlobalTemplate = normalizeTemplate(globalTemplate);
  if (normalizedGlobalTemplate) {
    return { template: normalizedGlobalTemplate, origin: "global_default" };
  }
  return { template: null, origin: "unset" };
}

export function resolveSourceControlTemplate(
  template: string | null,
  context: { role: string; agent: string },
) {
  const normalizedTemplate = normalizeTemplate(template);
  if (!normalizedTemplate) {
    return null;
  }
  const resolved = normalizedTemplate
    .split("{role}").join(context.role)
    .split("{agent}").join(context.agent)
    .trim();
  return resolved.length > 0 ? resolved : null;
}

export function findUnknownSourceControlVariables(value?: string | null) {
  const template = normalizeTemplate(value);
  if (!template) {
    return [] as string[];
  }

  const matches = Array.from(template.matchAll(/\{([^{}]+)\}/g));
  return [...new Set(matches
    .map((match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token && token !== "role" && token !== "agent"))
    .map((token) => `{${token}}`))];
}

export function getSourceControlTemplateErrors(settings: SourceControlTemplateSettings) {
  return {
    gitUserNameTemplate: findUnknownSourceControlVariables(settings.gitUserNameTemplate),
    gitEmailTemplate: findUnknownSourceControlVariables(settings.gitEmailTemplate),
  };
}

function buildPreviewWarnings(userName: string | null, email: string | null) {
  const warnings: string[] = [];
  if (!userName) {
    warnings.push("git user.name resolves to empty");
  }
  if (!email) {
    warnings.push("git user.email resolves to empty");
  } else if (!/^.+@.+\..+$/.test(email)) {
    warnings.push("git user.email does not look like an email");
  }
  return warnings;
}

export function buildSourceControlPreviewRows(
  globalSettings: SourceControlTemplateSettings,
  projectSettings?: SourceControlTemplateSettings | null,
): SourceControlPreviewRow[] {
  return PREVIEW_CONTEXTS.map((context) => {
    const gitUserName = resolveSourceControlFieldOrigin(
      projectSettings?.gitUserNameTemplate,
      globalSettings.gitUserNameTemplate,
    );
    const gitEmail = resolveSourceControlFieldOrigin(
      projectSettings?.gitEmailTemplate,
      globalSettings.gitEmailTemplate,
    );
    const resolvedUserName = resolveSourceControlTemplate(gitUserName.template, context);
    const resolvedEmail = resolveSourceControlTemplate(gitEmail.template, context);

    return {
      key: context.key,
      label: context.label,
      gitUserName: {
        template: gitUserName.template,
        resolved: resolvedUserName,
        origin: gitUserName.origin,
      },
      gitEmail: {
        template: gitEmail.template,
        resolved: resolvedEmail,
        origin: gitEmail.origin,
      },
      warnings: buildPreviewWarnings(resolvedUserName, resolvedEmail),
    };
  });
}

export async function getSourceControlSettings(): Promise<SourceControlSettings> {
  if (!isTauriAvailable()) {
    return getStoredSourceControlSettings();
  }
  return invoke<SourceControlSettings>("get_source_control_settings");
}

export async function updateSourceControlSettings(
  gitUserNameTemplate: string | null,
  gitEmailTemplate: string | null,
): Promise<SourceControlSettings> {
  if (!isTauriAvailable()) {
    const nextSettings: SourceControlSettings = {
      gitUserNameTemplate: normalizeTemplate(gitUserNameTemplate),
      gitEmailTemplate: normalizeTemplate(gitEmailTemplate),
      updatedAt: nowIso(),
    };
    saveStoredSourceControlSettings(nextSettings);
    return nextSettings;
  }

  return invoke<SourceControlSettings>("update_source_control_settings", {
    gitUserNameTemplate,
    gitEmailTemplate,
  });
}

export async function getProjectSourceControlSettings(projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectSourceControlSettings> {
  const resolvedProjectSlug = resolveProjectSlug(projectSlug);
  if (!isTauriAvailable()) {
    const runtimeSettings = getStoredMockProjectRuntimeSettings(resolvedProjectSlug);
    return {
      projectSlug: resolvedProjectSlug,
      gitUserNameTemplate: runtimeSettings.gitUserNameTemplate ?? null,
      gitEmailTemplate: runtimeSettings.gitEmailTemplate ?? null,
      updatedAt: runtimeSettings.updatedAt ?? null,
    };
  }

  return invoke<ProjectSourceControlSettings>("get_project_source_control_settings", {
    projectSlug: resolvedProjectSlug,
  });
}

export async function updateProjectSourceControlSettings(
  gitUserNameTemplate: string | null,
  gitEmailTemplate: string | null,
  projectSlug = DEFAULT_PROJECT_SLUG,
): Promise<ProjectSourceControlSettings> {
  const resolvedProjectSlug = resolveProjectSlug(projectSlug);
  if (!isTauriAvailable()) {
    updateStoredMockProjectRuntimeSettings(resolvedProjectSlug, (current) => ({
      ...current,
      gitUserNameTemplate: normalizeTemplate(gitUserNameTemplate),
      gitEmailTemplate: normalizeTemplate(gitEmailTemplate),
      updatedAt: nowIso(),
    }));
    return getProjectSourceControlSettings(resolvedProjectSlug);
  }

  return invoke<ProjectSourceControlSettings>("update_project_source_control_settings", {
    projectSlug: resolvedProjectSlug,
    gitUserNameTemplate,
    gitEmailTemplate,
  });
}
