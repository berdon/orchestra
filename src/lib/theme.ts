export type OrchestraThemeKind = "light" | "dark" | "high-contrast";

export interface OrchestraThemeDefinition {
  id: string;
  label: string;
  kind: OrchestraThemeKind;
  colorScheme: "light" | "dark";
}

export const ORCHESTRA_THEME_STORAGE_KEY = "orchestra.preferences.theme";

export const BUILT_IN_ORCHESTRA_THEMES = [
  {
    id: "orchestra-light",
    label: "Orchestra Light",
    kind: "light",
    colorScheme: "light",
  },
  {
    id: "orchestra-dark",
    label: "Orchestra Dark",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "orchestra-high-contrast",
    label: "Orchestra High Contrast",
    kind: "high-contrast",
    colorScheme: "dark",
  },
  {
    id: "vscode-light-plus",
    label: "VS Code Light+",
    kind: "light",
    colorScheme: "light",
  },
  {
    id: "vscode-dark-plus",
    label: "VS Code Dark+",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "one-dark-pro",
    label: "One Dark Pro",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "dracula",
    label: "Dracula",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    kind: "light",
    colorScheme: "light",
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    colorScheme: "light",
  },
  {
    id: "nord",
    label: "Nord",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    kind: "dark",
    colorScheme: "dark",
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    kind: "light",
    colorScheme: "light",
  },
  {
    id: "monokai",
    label: "Monokai",
    kind: "dark",
    colorScheme: "dark",
  },
] as const satisfies readonly OrchestraThemeDefinition[];

export type OrchestraThemeId = (typeof BUILT_IN_ORCHESTRA_THEMES)[number]["id"];

export const DEFAULT_ORCHESTRA_THEME_ID: OrchestraThemeId = "orchestra-dark";

const BUILT_IN_ORCHESTRA_THEME_MAP = new Map<OrchestraThemeId, OrchestraThemeDefinition>(
  BUILT_IN_ORCHESTRA_THEMES.map((theme) => [theme.id, theme]),
);

const BUILT_IN_ORCHESTRA_THEME_IDS = new Set<OrchestraThemeId>(
  BUILT_IN_ORCHESTRA_THEMES.map((theme) => theme.id),
);

export function isOrchestraThemeId(value: string | null | undefined): value is OrchestraThemeId {
  return Boolean(value && BUILT_IN_ORCHESTRA_THEME_IDS.has(value as OrchestraThemeId));
}

export function getOrchestraThemeDefinition(themeId: OrchestraThemeId): OrchestraThemeDefinition {
  return BUILT_IN_ORCHESTRA_THEME_MAP.get(themeId) ?? BUILT_IN_ORCHESTRA_THEME_MAP.get(DEFAULT_ORCHESTRA_THEME_ID)!;
}

export function loadStoredOrchestraTheme(storage: Pick<Storage, "getItem"> = window.localStorage): OrchestraThemeId {
  const stored = storage.getItem(ORCHESTRA_THEME_STORAGE_KEY);
  return isOrchestraThemeId(stored) ? stored : DEFAULT_ORCHESTRA_THEME_ID;
}

export function storeOrchestraTheme(
  themeId: OrchestraThemeId,
  storage: Pick<Storage, "setItem"> = window.localStorage,
) {
  storage.setItem(ORCHESTRA_THEME_STORAGE_KEY, themeId);
}

export function applyOrchestraTheme(themeId: OrchestraThemeId, doc: Document = document) {
  const theme = getOrchestraThemeDefinition(themeId);
  doc.documentElement.dataset.theme = theme.id;
  doc.documentElement.dataset.themeKind = theme.kind;
  doc.documentElement.style.colorScheme = theme.colorScheme;
  if (doc.body) {
    doc.body.dataset.theme = theme.id;
    doc.body.dataset.themeKind = theme.kind;
  }
}
