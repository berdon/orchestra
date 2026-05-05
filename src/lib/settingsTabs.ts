import type { SettingsTab } from "../types";

export interface SettingsTabDescriptor {
  id: SettingsTab;
  label: string;
  commandPaletteSubtitle: string;
  commandPaletteKeywords: string[];
}

export interface VisibleSettingsTabsOptions {
  supportsHarnessSettings?: boolean;
  supportsRemoteAccess?: boolean;
  supportsSkillsSettings?: boolean;
}

const SETTINGS_TAB_METADATA = [
  {
    id: "projects",
    label: "Projects",
    commandPaletteSubtitle: "Project and repository management",
    commandPaletteKeywords: ["projects", "repositories"],
  },
  {
    id: "agents",
    label: "Agents",
    commandPaletteSubtitle: "Persistent agent definitions",
    commandPaletteKeywords: ["agents", "definitions"],
  },
  {
    id: "roles",
    label: "Roles",
    commandPaletteSubtitle: "Role definitions",
    commandPaletteKeywords: ["roles"],
  },
  {
    id: "workflows",
    label: "Workflows",
    commandPaletteSubtitle: "Workflow definitions",
    commandPaletteKeywords: ["workflows", "lanes"],
  },
  {
    id: "skills",
    label: "Skills",
    commandPaletteSubtitle: "Managed local and external skills catalog",
    commandPaletteKeywords: ["skills", "catalog", "managed skills", "skill editor"],
  },
  {
    id: "channels",
    label: "Channels",
    commandPaletteSubtitle: "Channel integrations and delivery configuration",
    commandPaletteKeywords: ["channels", "integrations", "delivery", "telegram"],
  },
  {
    id: "remote",
    label: "Remote",
    commandPaletteSubtitle: "Remote access and hosted connection settings",
    commandPaletteKeywords: ["remote", "hosted", "connection", "access"],
  },
  {
    id: "source_control",
    label: "Source Control",
    commandPaletteSubtitle: "Global git identity defaults and previews",
    commandPaletteKeywords: ["source control", "git", "identity", "commits"],
  },
  {
    id: "prompting",
    label: "Prompting",
    commandPaletteSubtitle: "Project prompt templates and prompt tokens",
    commandPaletteKeywords: ["prompting", "prompt", "template", "worker context"],
  },
  {
    id: "harness",
    label: "Harness",
    commandPaletteSubtitle: "Harness auth, model, runtime, and legacy import setup",
    commandPaletteKeywords: ["harness", "pi", "models", "auth", "providers", "runtime", "extensions", "compaction"],
  },
  {
    id: "general",
    label: "General",
    commandPaletteSubtitle: "Appearance, diagnostics, notifications, and runtime logs",
    commandPaletteKeywords: ["general", "appearance", "theme", "notifications", "bridge", "diagnostics", "logs"],
  },
] satisfies readonly SettingsTabDescriptor[];

export function compareSettingsTabsByLabel(
  left: Pick<SettingsTabDescriptor, "id" | "label">,
  right: Pick<SettingsTabDescriptor, "id" | "label">,
) {
  if (left.id === "general") {
    return right.id === "general" ? 0 : -1;
  }
  if (right.id === "general") {
    return 1;
  }
  return left.label.localeCompare(right.label);
}

export const SETTINGS_TABS = [...SETTINGS_TAB_METADATA].sort(
  compareSettingsTabsByLabel,
);

function isSettingsTabVisible(
  tab: Pick<SettingsTabDescriptor, "id">,
  {
    supportsHarnessSettings = false,
    supportsRemoteAccess = false,
    supportsSkillsSettings = false,
  }: VisibleSettingsTabsOptions,
) {
  if (tab.id === "harness") {
    return supportsHarnessSettings;
  }
  if (tab.id === "remote") {
    return supportsRemoteAccess;
  }
  if (tab.id === "skills") {
    return supportsSkillsSettings;
  }
  return true;
}

export function getVisibleSettingsTabs(
  options: VisibleSettingsTabsOptions,
): SettingsTabDescriptor[] {
  return SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab, options));
}
