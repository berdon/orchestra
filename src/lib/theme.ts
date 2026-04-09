export type OrchestraThemeId = "orchestra-light" | "orchestra-dark" | "orchestra-high-contrast";
export type OrchestraThemeKind = "light" | "dark" | "high-contrast";

export interface OrchestraThemeDefinition {
  id: OrchestraThemeId;
  label: string;
  kind: OrchestraThemeKind;
  colorScheme: "light" | "dark";
}

export const ORCHESTRA_THEME_STORAGE_KEY = "orchestra.preferences.theme";
export const DEFAULT_ORCHESTRA_THEME_ID: OrchestraThemeId = "orchestra-light";

export const BUILT_IN_ORCHESTRA_THEMES: OrchestraThemeDefinition[] = [
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
];

const BUILT_IN_ORCHESTRA_THEME_MAP = new Map<OrchestraThemeId, OrchestraThemeDefinition>(
  BUILT_IN_ORCHESTRA_THEMES.map((theme) => [theme.id, theme]),
);

export function isOrchestraThemeId(value: string | null | undefined): value is OrchestraThemeId {
  return value === "orchestra-light" || value === "orchestra-dark" || value === "orchestra-high-contrast";
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
