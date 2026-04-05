import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type {
  ProjectSessionPromptSettings,
  ProjectTaskAutomationSettings,
  ProjectWorkerOverlay,
} from "../types";

const PROJECT_SETTINGS_STORAGE_KEY = "orchestra.mock.project-settings";
const DEFAULT_PROJECT_SLUG = "orchestra";

type MockProjectSettings = {
  agentOverlays?: Record<string, { prompt?: string | null; updatedAt?: string | null }>;
  roleOverlays?: Record<string, { prompt?: string | null; updatedAt?: string | null }>;
  general?: {
    taskSessionContextTemplate?: string | null;
    autoDispatchOnBlockerCompletion?: boolean;
    updatedAt?: string | null;
  };
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

const DEFAULT_SESSION_PROMPT_TEMPLATE = [
  "You are an agent working inside Orchestra on task {TASK.NUMBER} — {TASK.NAME}.",
  "Canonical task ID: {TASK.ID}",
  "Task slug: {TASK.SLUG}",
  "Orchestra is the project orchestration system. It tracks tasks, workflows, worker ownership, runtime sessions, comments, attachments, and transitions between steps of work. You are operating as a worker inside that system, so your job is not just to do good work — it is to keep Orchestra's state accurate as you work.",
  "Orchestra concepts you need to understand:\n- Task: the tracked unit of work you are responsible for right now. Tasks can have descriptions, comments, attachments, todos, subtasks, dependencies, and workflow history.\n- Workflow: the overall process definition attached to a task. A workflow contains ordered lanes and transition rules.\n- Lane: the current step of the workflow. Each lane has an owner type (user, role, or agent) and defines what should happen on success or failure.\n- Session: the running conversation/runtime for a worker. This session is the place where you reason, inspect task context, and decide how to move the task forward.\n- Transition: the explicit tool call that moves the task out of the current lane. You must always end your work by choosing the correct transition tool.",
  "Workflow: {WORKFLOW.NAME}",
  "Current lane: {LANE.NAME}",
  "Lane owner: {LANE.OWNER}",
  "Task status: {TASK.STATUS}",
  "Task assignee: {TASK.ASSIGNEE}",
  "Runtime cwd: {RUNTIME.CWD}",
  "",
  "{WORKER.CONTEXT}",
  "{TASK.DESCRIPTION}",
  "{TASK.BLOCKED_BY}",
  "{TASK.REPOSITORIES}",
  "{TASK.FILE_REFERENCES}",
  "{TASK.ATTACHMENTS}",
  "{TASK.TODOS}",
  "{TASK.COMMENTS}",
  "{LANE.INSTRUCTION}",
  "{ORCHESTRA.WORKING_RULES}",
  "{ORCHESTRA.TOOL_HELP}",
  "{ORCHESTRA.COMPLETION_RULES}",
].join("\n");

const SESSION_PROMPT_TOKENS = [
  { token: "{TASK.ID}", description: "Canonical Orchestra task id." },
  { token: "{TASK.NUMBER}", description: "Human-readable task number such as ORC-42." },
  { token: "{TASK.SLUG}", description: "Slugified task title for prompt customization." },
  { token: "{TASK.NAME}", description: "Task title/name." },
  { token: "{TASK.STATUS}", description: "Current task status." },
  { token: "{TASK.ASSIGNEE}", description: "Current assignee label." },
  { token: "{TASK.DESCRIPTION}", description: "Task description block when present." },
  { token: "{TASK.COMMENTS}", description: "Recent task comments block." },
  { token: "{TASK.BLOCKED_BY}", description: "Blocking tasks block." },
  { token: "{TASK.REPOSITORIES}", description: "Task repositories block." },
  { token: "{TASK.FILE_REFERENCES}", description: "Tracked project file references block." },
  { token: "{TASK.ATTACHMENTS}", description: "Task attachments block." },
  { token: "{TASK.TODOS}", description: "Task todo items block." },
  { token: "{WORKFLOW.NAME}", description: "Workflow name." },
  { token: "{LANE.NAME}", description: "Current lane name." },
  { token: "{LANE.OWNER}", description: "Current lane owner type." },
  { token: "{LANE.INSTRUCTION}", description: "Lane entry instruction block." },
  { token: "{WORKER.CONTEXT}", description: "Worker-specific prompt context block including base and overlay prompts." },
  { token: "{RUNTIME.CWD}", description: "Resolved task workspace cwd for the current lane." },
  { token: "{ORCHESTRA.WORKING_RULES}", description: "Standard Orchestra working rules block." },
  { token: "{ORCHESTRA.TOOL_HELP}", description: "Standard Orchestra task tool help block." },
  { token: "{ORCHESTRA.COMPLETION_RULES}", description: "Standard Orchestra completion rules block." },
] as const;

export async function getSessionPromptSettings(projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectSessionPromptSettings> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    return {
      projectSlug,
      template: settings.general?.taskSessionContextTemplate ?? DEFAULT_SESSION_PROMPT_TEMPLATE,
      defaultTemplate: DEFAULT_SESSION_PROMPT_TEMPLATE,
      availableTokens: [...SESSION_PROMPT_TOKENS],
      updatedAt: settings.general?.updatedAt ?? null,
    };
  }

  return invoke<ProjectSessionPromptSettings>("get_session_prompt_settings", { projectSlug });
}

export async function updateSessionPromptSettings(template: string | null, projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectSessionPromptSettings> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    settings.general = {
      ...(settings.general ?? {}),
      taskSessionContextTemplate: template?.trim() || null,
      updatedAt: nowIso(),
    };
    saveStoredProjectSettings(settings);
    return getSessionPromptSettings(projectSlug);
  }

  return invoke<ProjectSessionPromptSettings>("update_session_prompt_settings", { projectSlug, template });
}

export async function getTaskAutomationSettings(projectSlug = DEFAULT_PROJECT_SLUG): Promise<ProjectTaskAutomationSettings> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    return {
      projectSlug,
      autoDispatchOnBlockerCompletion: settings.general?.autoDispatchOnBlockerCompletion ?? true,
      updatedAt: settings.general?.updatedAt ?? null,
    };
  }

  return invoke<ProjectTaskAutomationSettings>("get_task_automation_settings", { projectSlug });
}

export async function updateTaskAutomationSettings(
  autoDispatchOnBlockerCompletion: boolean,
  projectSlug = DEFAULT_PROJECT_SLUG,
): Promise<ProjectTaskAutomationSettings> {
  if (!isTauriAvailable()) {
    const settings = getStoredProjectSettings();
    settings.general = {
      ...(settings.general ?? {}),
      autoDispatchOnBlockerCompletion,
      updatedAt: nowIso(),
    };
    saveStoredProjectSettings(settings);
    return getTaskAutomationSettings(projectSlug);
  }

  return invoke<ProjectTaskAutomationSettings>("update_task_automation_settings", {
    projectSlug,
    autoDispatchOnBlockerCompletion,
  });
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
